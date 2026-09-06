import { z } from "zod";
import * as path from "node:path";

import {
  redactSourceText,
  readSecureTextFile,
  resolveSecureDirectory,
  resolveSecureFile,
  scanInstructionSignals,
} from "@core/security";
import type { Position } from "@core/ast/types";
import type { Feature, FeatureResult } from "@features/types";
import {
  createFeatureResultSchema,
  instructionSignalsSchema,
  positionSchema,
} from "@features/utils";

export const codeSnippetSchema = z
  .object({
    directory: z.string().optional().default(".").describe("Project root"),
    file_path: z.string().describe("File path relative to directory"),
    start_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Inclusive UTF-8 byte offset"),
    end_offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Exclusive UTF-8 byte offset"),
    max_bytes: z
      .number()
      .int()
      .positive()
      .max(50_000)
      .default(12_000)
      .describe("Maximum returned UTF-8 bytes"),
    redact_secrets: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Redact common secrets; offsets remain those of the original file",
      ),
  })
  .refine(
    (value) =>
      value.end_offset === undefined || value.end_offset >= value.start_offset,
    {
      message: "end_offset must be greater than or equal to start_offset",
      path: ["end_offset"],
    },
  );

export type CodeSnippetInput = z.input<typeof codeSnippetSchema>;

const codeSnippetDataSchema = z
  .object({
    file_path: z.string(),
    start_offset: z.number().int().nonnegative(),
    end_offset: z.number().int().nonnegative(),
    start: positionSchema,
    end: positionSchema,
    content: z.string(),
    truncated: z.boolean(),
    source_is_untrusted: z.literal(true),
    source_redacted: z.boolean(),
    instruction_signals: instructionSignalsSchema,
  })
  .strict();

export const codeSnippetOutputSchema = createFeatureResultSchema(
  codeSnippetDataSchema,
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

function positionAt(content: string, index: number): Position {
  const prefix = content.slice(0, index);
  const lineStart = prefix.lastIndexOf("\n");
  return {
    line: (prefix.match(/\n/g) ?? []).length + 1,
    column: index - lineStart - 1,
    offset: Buffer.byteLength(prefix, "utf8"),
  };
}

export async function execute(
  rawInput: CodeSnippetInput,
): Promise<FeatureResult> {
  await Promise.resolve();
  let input: z.output<typeof codeSnippetSchema>;
  try {
    input = codeSnippetSchema.parse(rawInput);
  } catch {
    return { success: false, error: "Invalid code snippet range" };
  }
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

  const content = readResult.content;
  const fileBytes = Buffer.byteLength(content, "utf8");
  if (input.start_offset > fileBytes) {
    return { success: false, error: "start_offset is outside the file" };
  }
  const requestedEnd =
    input.end_offset ??
    Math.min(fileBytes, input.start_offset + input.max_bytes);
  const endOffset = Math.min(
    requestedEnd,
    input.start_offset + input.max_bytes,
    fileBytes,
  );
  const startIndex = stringIndexAtByteOffset(content, input.start_offset);
  const endIndex = stringIndexAtByteOffset(content, endOffset);
  const source = input.redact_secrets
    ? redactSourceText(content.slice(startIndex, endIndex))
    : { text: content.slice(startIndex, endIndex), redacted: false };
  const relativeFilePath = path
    .relative(root, secureFile.path)
    .replace(/\\/gu, "/");
  const output = {
    file_path: relativeFilePath,
    start_offset: input.start_offset,
    end_offset: endOffset,
    start: positionAt(content, startIndex),
    end: positionAt(content, endIndex),
    content: source.text,
    truncated: endOffset < requestedEnd,
    source_is_untrusted: true as const,
    source_redacted: source.redacted,
    instruction_signals: scanInstructionSignals(
      content.slice(startIndex, endIndex),
      {
        source: relativeFilePath,
      },
    ),
  };
  return {
    success: true,
    message: `Read ${String(Buffer.byteLength(output.content, "utf8"))} bytes`,
    data: output,
  };
}

export const codeSnippetFeature: Feature<typeof codeSnippetSchema> = {
  name: "get_code_snippet",
  title: "Get code snippet",
  description:
    "Read-only bounded source retrieval by exact UTF-8 byte offsets, with line/column positions and no code execution.",
  schema: codeSnippetSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  outputSchema: codeSnippetOutputSchema,
  execute,
};
