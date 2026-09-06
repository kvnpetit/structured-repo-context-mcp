import { z } from "zod";
import * as path from "node:path";

import { parseCode } from "@core/parser";
import { extractCodeInfo } from "@core/symbols";
import {
  redactSourceText,
  readSecureTextFile,
  resolveSecureDirectory,
  resolveSecureFile,
} from "@core/security";
import type { Feature, FeatureResult } from "@features/types";
import { createFeatureResultSchema, positionSchema } from "@features/utils";

const DEFAULT_MAX_SOURCE_BYTES = 20_000;

export const symbolAtPositionSchema = z.object({
  directory: z.string().optional().default(".").describe("Project directory"),
  file_path: z.string().describe("Source file path relative to directory"),
  line: z.number().int().positive().describe("1-based source line"),
  column: z.number().int().min(0).describe("0-based character column"),
  include_source: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include a bounded exact symbol body when found"),
  max_source_bytes: z
    .number()
    .int()
    .positive()
    .max(100_000)
    .optional()
    .default(DEFAULT_MAX_SOURCE_BYTES)
    .describe("Maximum source bytes returned for the symbol"),
  redact_secrets: z
    .boolean()
    .optional()
    .default(true)
    .describe("Redact common secrets in returned source (default: true)"),
});

export type SymbolAtPositionInput = z.input<typeof symbolAtPositionSchema>;

interface SymbolAtPositionOutput {
  file_path: string;
  language: string;
  parser: "tree-sitter";
  position: { line: number; column: number; offset: number };
  found: boolean;
  source_is_untrusted: true;
  secrets_redacted: boolean;
  symbol: {
    name: string;
    type: string;
    start: { line: number; column: number; offset: number };
    end: { line: number; column: number; offset: number };
    signature?: string;
    modifiers?: string[];
    documentation?: string;
    source?: string;
    source_truncated?: boolean;
  } | null;
}

const symbolAtPositionDataSchema = z
  .object({
    file_path: z.string(),
    language: z.string(),
    parser: z.literal("tree-sitter"),
    position: positionSchema,
    found: z.boolean(),
    source_is_untrusted: z.literal(true),
    secrets_redacted: z.boolean(),
    symbol: z
      .object({
        name: z.string(),
        type: z.string(),
        start: positionSchema,
        end: positionSchema,
        signature: z.string().optional(),
        modifiers: z.string().array().optional(),
        documentation: z.string().optional(),
        source: z.string().optional(),
        source_truncated: z.boolean().optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const symbolAtPositionOutputSchema = createFeatureResultSchema(
  symbolAtPositionDataSchema,
);

function stringIndexAtByteOffset(content: string, byteOffset: number): number {
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(content.slice(0, middle), "utf8") <= byteOffset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

function byteOffsetAtPosition(
  content: string,
  line: number,
  column: number,
): number | undefined {
  const lines = content.split("\n");
  const lineText = lines[line - 1];
  if (lineText === undefined) {
    return undefined;
  }
  const withoutCarriageReturn = lineText.endsWith("\r")
    ? lineText.slice(0, -1)
    : lineText;
  const characters = Array.from(withoutCarriageReturn);
  if (column > characters.length) {
    return undefined;
  }
  const before = lines
    .slice(0, line - 1)
    .reduce((total, value) => total + value.length + 1, 0);
  const prefix = withoutCarriageReturn.slice(
    0,
    characters.slice(0, column).join("").length,
  );
  return (
    Buffer.byteLength(content.slice(0, before), "utf8") +
    Buffer.byteLength(prefix, "utf8")
  );
}

function relativePath(root: string, filePath: string): string {
  return path.relative(root, filePath).replace(/\\/gu, "/");
}

export async function execute(
  rawInput: SymbolAtPositionInput,
): Promise<FeatureResult> {
  const input = symbolAtPositionSchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }
  const root = secureDirectory.path;
  const secureFile = resolveSecureFile(
    path.resolve(root, input.file_path),
    root,
  );
  if (!secureFile.ok) {
    return { success: false, error: secureFile.error };
  }
  const readResult = readSecureTextFile(secureFile.path, root);
  if (!readResult.ok || readResult.content === undefined) {
    return {
      success: false,
      error: readResult.ok ? "File cannot be read" : readResult.error,
    };
  }

  const offset = byteOffsetAtPosition(
    readResult.content,
    input.line,
    input.column,
  );
  if (offset === undefined) {
    return { success: false, error: "Position is outside the file" };
  }

  try {
    const parsed = await parseCode(readResult.content, {
      filePath: secureFile.path,
    });
    const info = extractCodeInfo(
      parsed.tree,
      parsed.languageInstance,
      parsed.language,
    );
    const containing = info.symbols.symbols
      .filter(
        (symbol) =>
          symbol.start.offset <= offset &&
          (offset < symbol.end.offset ||
            (offset === symbol.end.offset &&
              symbol.start.offset < symbol.end.offset)),
      )
      .sort(
        (left, right) =>
          left.end.offset -
            left.start.offset -
            (right.end.offset - right.start.offset) ||
          left.start.offset - right.start.offset,
      );
    const selected = containing[0];
    let secretsRedacted = false;
    const output: SymbolAtPositionOutput = {
      file_path: relativePath(root, secureFile.path),
      language: parsed.language,
      parser: "tree-sitter",
      position: {
        line: input.line,
        column: input.column,
        offset,
      },
      found: selected !== undefined,
      source_is_untrusted: true,
      secrets_redacted: false,
      symbol: selected
        ? {
            name: selected.name,
            type: selected.type,
            start: selected.start,
            end: selected.end,
            ...(selected.signature === undefined
              ? {}
              : { signature: selected.signature }),
            ...(selected.modifiers === undefined
              ? {}
              : { modifiers: selected.modifiers }),
            ...(selected.documentation === undefined
              ? {}
              : { documentation: selected.documentation }),
            ...(input.include_source
              ? (() => {
                  const start = stringIndexAtByteOffset(
                    readResult.content,
                    selected.start.offset,
                  );
                  const end = stringIndexAtByteOffset(
                    readResult.content,
                    selected.end.offset,
                  );
                  const rawSource = readResult.content.slice(start, end);
                  const sourceBytes = Buffer.byteLength(rawSource, "utf8");
                  const boundedSource = rawSource.slice(
                    0,
                    stringIndexAtByteOffset(rawSource, input.max_source_bytes),
                  );
                  const source = input.redact_secrets
                    ? redactSourceText(boundedSource)
                    : { text: boundedSource, redacted: false };
                  secretsRedacted ||= source.redacted;
                  return {
                    source: source.text,
                    ...(sourceBytes > input.max_source_bytes
                      ? { source_truncated: true }
                      : {}),
                  };
                })()
              : {}),
          }
        : null,
    };
    output.secrets_redacted = secretsRedacted;
    return {
      success: true,
      message: selected
        ? `Symbol ${selected.name} (${selected.type}) at ${relativePath(root, secureFile.path)}:${String(input.line)}`
        : `No symbol found at ${relativePath(root, secureFile.path)}:${String(input.line)}:${String(input.column)}`,
      data: output,
    };
  } catch {
    return {
      success: false,
      error:
        "Symbol lookup is unavailable for this file; use analyze_file or find_symbols for fallback parsing",
    };
  }
}

export const symbolAtPositionFeature: Feature<typeof symbolAtPositionSchema> = {
  name: "get_symbol_at_position",
  title: "Get symbol at position",
  description:
    "Resolve the smallest Tree-sitter symbol containing an exact 1-based line and 0-based column. Returns byte-precise ranges and a bounded source body for efficient code navigation.",
  schema: symbolAtPositionSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  outputSchema: symbolAtPositionOutputSchema,
  execute,
};
