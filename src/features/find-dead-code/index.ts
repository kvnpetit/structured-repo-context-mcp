import { z } from "zod";
import * as path from "node:path";

import type { Symbol } from "@core/ast/types";
import { collectFiles, createIgnoreFilter } from "@core/files";
import { parseCode } from "@core/parser";
import { extractCodeInfo } from "@core/symbols";
import { readSecureTextFile, resolveSecureDirectory } from "@core/security";
import type { Feature, FeatureResult } from "@features/types";
import { createFeatureResultSchema, positionSchema, symbolTypeSchema } from "@features/utils";

export const findDeadCodeSchema = z.object({
  directory: z.string().optional().default(".").describe("Project directory"),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .default(100)
    .describe("Maximum candidates to return"),
  max_files: z
    .number()
    .int()
    .positive()
    .max(2000)
    .optional()
    .default(500)
    .describe("Maximum source files to inspect"),
  include_tests: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include test/spec files in the analysis (default: false)"),
});

export type FindDeadCodeInput = z.input<typeof findDeadCodeSchema>;

interface DeadCodeCandidate {
  name: string;
  type: Symbol["type"];
  file_path: string;
  start: Symbol["start"];
  end: Symbol["end"];
  signature?: string;
  reference_count: number;
  definition_count: number;
  exported: boolean;
  confidence: number;
  reason: "no_references";
}

interface DeadCodeOutput {
  directory: string;
  files_analyzed: number;
  files_skipped: number;
  symbols_analyzed: number;
  truncated: boolean;
  candidates: DeadCodeCandidate[];
  errors: string[];
  limitations: string[];
}

interface ParsedFile {
  path: string;
  content: string;
  symbols: Symbol[];
  exportedNames: Set<string>;
}

const deadCodeDataSchema = z
  .object({
    directory: z.string(),
    files_analyzed: z.number().int().nonnegative(),
    files_skipped: z.number().int().nonnegative(),
    symbols_analyzed: z.number().int().nonnegative(),
    truncated: z.boolean(),
    candidates: z
      .object({
        name: z.string(),
        type: symbolTypeSchema,
        file_path: z.string(),
        start: positionSchema,
        end: positionSchema,
        signature: z.string().optional(),
        reference_count: z.number().int().nonnegative(),
        definition_count: z.number().int().nonnegative(),
        exported: z.boolean(),
        confidence: z.number().min(0).max(1),
        reason: z.literal("no_references"),
      })
      .strict()
      .array(),
    errors: z.string().array(),
    limitations: z.string().array(),
  })
  .strict();

export const findDeadCodeOutputSchema = createFeatureResultSchema(deadCodeDataSchema);

const analyzableTypes = new Set<Symbol["type"]>([
  "function",
  "method",
  "class",
  "interface",
  "type",
  "enum",
]);

const conventionalEntrypoints = new Set(["main", "constructor", "__init__"]);

function relativePath(root: string, filePath: string): string {
  return path.relative(root, filePath).replace(/\\/gu, "/");
}

function isTestPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/gu, "/").toLowerCase();
  return (
    /(?:^|\/)(?:test|tests|__tests__|spec|specs)(?:\/|$)/u.test(normalized) ||
    /(?:\.test|\.spec|_test|_spec)(?:\.[^/]+)+$/u.test(normalized)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function countIdentifierOccurrences(contents: string[], name: string): number {
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "gu");
  let count = 0;
  for (const content of contents) {
    count += Array.from(content.matchAll(pattern)).length;
  }
  return count;
}

function isExported(symbol: Symbol, exportedNames: Set<string>): boolean {
  return symbol.modifiers?.includes("export") === true || exportedNames.has(symbol.name);
}

function candidateConfidence(
  symbol: Symbol,
  definitionCount: number,
  referenceCount: number,
): number {
  let confidence = referenceCount === 0 ? 0.82 : 0.68;
  if (definitionCount > 1) {
    confidence -= 0.35;
  }
  if (symbol.type === "method") {
    confidence -= 0.12;
  }
  return Math.max(0, Math.min(1, confidence));
}

export async function execute(rawInput: FindDeadCodeInput): Promise<FeatureResult> {
  const input = findDeadCodeSchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }

  const root = secureDirectory.path;
  const ignore = createIgnoreFilter(root);
  const allFiles = collectFiles(root, ignore, root).sort((left, right) =>
    relativePath(root, left).localeCompare(relativePath(root, right)),
  );
  const files = input.include_tests
    ? allFiles
    : allFiles.filter((file) => !isTestPath(relativePath(root, file)));
  const boundedFiles = files.slice(0, input.max_files);
  const output: DeadCodeOutput = {
    directory: root,
    files_analyzed: 0,
    files_skipped: allFiles.length - boundedFiles.length,
    symbols_analyzed: 0,
    truncated: false,
    candidates: [],
    errors: [],
    limitations: [
      "This is a conservative syntax/text analysis, not a compiler or LSP reachability proof.",
      "Dynamic calls, reflection, dependency injection, generated code, and external consumers may hide references.",
      "Comments and string literals can create false references; validate candidates before removing code.",
    ],
  };

  const parsedFiles: ParsedFile[] = [];
  for (const file of boundedFiles) {
    const readResult = readSecureTextFile(file, root);
    if (!readResult.ok || readResult.content === undefined) {
      output.errors.push(`Cannot read ${relativePath(root, file)}`);
      continue;
    }
    try {
      const parsed = await parseCode(readResult.content, { filePath: file });
      const info = extractCodeInfo(parsed.tree, parsed.languageInstance, parsed.language);
      parsedFiles.push({
        path: file,
        content: readResult.content,
        symbols: info.symbols.symbols.filter((symbol) => analyzableTypes.has(symbol.type)),
        exportedNames: new Set(info.exports.map((item) => item.name)),
      });
      output.files_analyzed++;
    } catch {
      output.errors.push(`Cannot parse ${relativePath(root, file)}`);
    }
  }

  const contents = parsedFiles.map((file) => file.content);
  const symbolsByName = new Map<string, { symbol: Symbol; file: ParsedFile }[]>();
  for (const file of parsedFiles) {
    for (const symbol of file.symbols) {
      const entries = symbolsByName.get(symbol.name) ?? [];
      entries.push({ symbol, file });
      symbolsByName.set(symbol.name, entries);
    }
  }

  const candidates: DeadCodeCandidate[] = [];
  for (const [name, entries] of symbolsByName) {
    const definitionCount = entries.length;
    const occurrences = countIdentifierOccurrences(contents, name);
    const referenceCount = Math.max(0, occurrences - definitionCount);

    for (const { symbol, file } of entries) {
      output.symbols_analyzed++;
      const exported = isExported(symbol, file.exportedNames);
      if (
        exported ||
        conventionalEntrypoints.has(name) ||
        definitionCount > 1 ||
        referenceCount > 0
      ) {
        continue;
      }

      candidates.push({
        name,
        type: symbol.type,
        file_path: relativePath(root, file.path),
        start: symbol.start,
        end: symbol.end,
        signature: symbol.signature,
        reference_count: referenceCount,
        definition_count: definitionCount,
        exported,
        confidence: candidateConfidence(symbol, definitionCount, referenceCount),
        reason: "no_references",
      });
    }
  }

  output.candidates = candidates
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.file_path.localeCompare(right.file_path) ||
        left.start.line - right.start.line ||
        left.name.localeCompare(right.name),
    )
    .slice(0, input.limit);
  output.truncated = candidates.length > output.candidates.length;

  return {
    success: true,
    message: `Found ${String(output.candidates.length)} probable dead-code candidate${output.candidates.length === 1 ? "" : "s"}`,
    data: output,
  };
}

export const findDeadCodeFeature: Feature<typeof findDeadCodeSchema> = {
  name: "find_dead_code",
  title: "Find dead code",
  description:
    "Conservatively identify unexported functions, methods, classes, and types with no visible references. Read-only heuristic analysis with confidence and limitations; never removes code.",
  schema: findDeadCodeSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  outputSchema: findDeadCodeOutputSchema,
  execute,
};
