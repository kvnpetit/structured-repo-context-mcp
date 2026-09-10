import { z } from "zod";
import * as path from "node:path";

import { collectFiles, createIgnoreFilter } from "@core/files";
import { parseCode } from "@core/parser";
import type { Symbol } from "@core/ast/types";
import { extractCodeInfo } from "@core/symbols";
import {
  redactSourceText,
  readSecureTextFile,
  resolveSecureDirectory,
  resolveSecureFile,
  scanInstructionSignals,
} from "@core/security";
import { readPathAliasesCached } from "@core/utils";
import type { Feature, FeatureResult } from "@features/types";
import { createFeatureResultSchema, instructionSignalsSchema } from "@features/utils";

const DEFAULT_MAX_TOKENS = 2_000;
const DEFAULT_MAX_FILES = 500;
const MAX_ITERATIONS = 30;
const PAGE_RANK_DAMPING = 0.85;

export const repositoryMapSchema = z.object({
  directory: z.string().optional().default(".").describe("Project directory"),
  focus: z
    .array(z.string().trim().min(1))
    .max(20)
    .optional()
    .default([])
    .describe("Optional paths or symbols to prioritize"),
  max_tokens: z
    .number()
    .int()
    .positive()
    .max(20_000)
    .optional()
    .default(DEFAULT_MAX_TOKENS)
    .describe("Approximate maximum size of the textual map"),
  max_files: z
    .number()
    .int()
    .positive()
    .max(2_000)
    .optional()
    .default(DEFAULT_MAX_FILES)
    .describe("Maximum files to inspect"),
  redact_secrets: z
    .boolean()
    .optional()
    .default(true)
    .describe("Redact common secrets in the rendered map (default: true)"),
});

export type RepositoryMapInput = z.input<typeof repositoryMapSchema>;

interface FileEntry {
  absolutePath: string;
  relativePath: string;
  language: string;
  symbols: Symbol[];
  imports: string[];
  error?: string;
}

interface RankedFile {
  entry: FileEntry;
  rank: number;
  focusScore: number;
}

interface RepositoryMapOutput {
  directory: string;
  files_analyzed: number;
  files_included: number;
  symbols_included: number;
  token_budget: number;
  estimated_tokens: number;
  truncated: boolean;
  secrets_redacted: boolean;
  instruction_signals: ReturnType<typeof scanInstructionSignals>;
  focus: string[];
  map: string;
  ranked_files: {
    path: string;
    language: string;
    score: number;
    symbols: number;
  }[];
  errors: string[];
}

const repositoryMapDataSchema = z
  .object({
    directory: z.string(),
    files_analyzed: z.number().int().nonnegative(),
    files_included: z.number().int().nonnegative(),
    symbols_included: z.number().int().nonnegative(),
    token_budget: z.number().int().positive(),
    estimated_tokens: z.number().int().nonnegative(),
    truncated: z.boolean(),
    secrets_redacted: z.boolean(),
    instruction_signals: instructionSignalsSchema,
    focus: z.string().array(),
    map: z.string(),
    ranked_files: z
      .object({
        path: z.string(),
        language: z.string(),
        score: z.number(),
        symbols: z.number().int().nonnegative(),
      })
      .strict()
      .array(),
    errors: z.string().array(),
  })
  .strict();

export const repositoryMapOutputSchema = createFeatureResultSchema(repositoryMapDataSchema);

function relativePath(root: string, value: string): string {
  return path.relative(root, value).replace(/\\/gu, "/");
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "").toLowerCase();
}

function focusScore(entry: FileEntry, focus: readonly string[]): number {
  if (focus.length === 0) {
    return 0;
  }
  const searchable = [
    normalizePath(entry.relativePath),
    ...entry.symbols.map((symbol) => symbol.name.toLowerCase()),
  ];
  return focus.reduce((score, item) => {
    const normalized = normalizePath(item);
    return (
      score +
      (searchable.some((value) => value === normalized) ? 3 : 0) +
      (searchable.some((value) => value.includes(normalized)) ? 1 : 0)
    );
  }, 0);
}

function resolveImport(
  source: string,
  currentFile: string,
  root: string,
  aliases: Record<string, string>,
): string | undefined {
  let base: string | undefined;
  for (const [alias, target] of Object.entries(aliases)) {
    if (source === alias || source.startsWith(`${alias}/`)) {
      base = path.resolve(root, target, source.slice(alias.length).replace(/^[/\\]/u, ""));
      break;
    }
  }
  if (base === undefined && source.startsWith(".")) {
    base = path.resolve(path.dirname(currentFile), source);
  }
  if (base === undefined) {
    return undefined;
  }

  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java"];
  const candidates = [
    base,
    ...extensions.map((extension) => `${base}${extension}`),
    ...extensions.map((extension) => path.join(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    const secure = resolveSecureFile(candidate, root);
    if (secure.ok) {
      return secure.path;
    }
  }
  return undefined;
}

function buildFileGraph(
  entries: readonly FileEntry[],
  root: string,
  aliases: Record<string, string>,
): Map<string, Set<string>> {
  const known = new Set(entries.map((entry) => entry.absolutePath));
  const graph = new Map<string, Set<string>>();
  for (const entry of entries) {
    const targets = new Set<string>();
    for (const source of entry.imports) {
      const target = resolveImport(source, entry.absolutePath, root, aliases);
      if (target !== undefined && known.has(target)) {
        targets.add(target);
      }
    }
    graph.set(entry.absolutePath, targets);
  }
  return graph;
}

function rankFiles(
  entries: readonly FileEntry[],
  graph: Map<string, Set<string>>,
  focus: readonly string[],
): RankedFile[] {
  const scores = new Map<string, number>();
  const focusScores = new Map<string, number>();
  const totalFocus = entries.reduce((total, entry) => {
    const score = focusScore(entry, focus);
    focusScores.set(entry.absolutePath, score);
    return total + (score > 0 ? score : 1);
  }, 0);
  for (const entry of entries) {
    scores.set(entry.absolutePath, 1 / Math.max(entries.length, 1));
  }

  const incoming = new Map<string, string[]>();
  for (const [from, targets] of graph) {
    for (const target of targets) {
      const sources = incoming.get(target) ?? [];
      sources.push(from);
      incoming.set(target, sources);
    }
  }

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const next = new Map<string, number>();
    for (const entry of entries) {
      const personalization =
        ((focusScores.get(entry.absolutePath) ?? 0) + 1) / Math.max(totalFocus + entries.length, 1);
      let inbound = 0;
      for (const source of incoming.get(entry.absolutePath) ?? []) {
        const outgoingCount = graph.get(source)?.size ?? 0;
        if (outgoingCount > 0) {
          inbound += (scores.get(source) ?? 0) / outgoingCount;
        }
      }
      next.set(
        entry.absolutePath,
        (1 - PAGE_RANK_DAMPING) * personalization + PAGE_RANK_DAMPING * inbound,
      );
    }
    let difference = 0;
    for (const entry of entries) {
      difference += Math.abs(
        (next.get(entry.absolutePath) ?? 0) - (scores.get(entry.absolutePath) ?? 0),
      );
    }
    scores.clear();
    for (const [key, value] of next) {
      scores.set(key, value);
    }
    if (difference < 0.000_001) {
      break;
    }
  }

  return entries
    .map((entry) => ({
      entry,
      rank: scores.get(entry.absolutePath) ?? 0,
      focusScore: focusScores.get(entry.absolutePath) ?? 0,
    }))
    .sort(
      (left, right) =>
        right.focusScore - left.focusScore ||
        right.rank - left.rank ||
        left.entry.relativePath.localeCompare(right.entry.relativePath),
    );
}

function symbolLine(symbol: Symbol): string {
  const signature = symbol.signature === undefined ? "" : ` ${symbol.signature}`;
  return `  - ${symbol.type} ${symbol.name}${signature} (line ${String(symbol.start.line)})`;
}

function renderMap(
  ranked: readonly RankedFile[],
  maxTokens: number,
): { text: string; files: number; symbols: number; truncated: boolean } {
  const maxCharacters = maxTokens * 4;
  const lines = ["# Repository map", ""];
  let includedFiles = 0;
  let includedSymbols = 0;
  let truncated = false;

  for (const item of ranked) {
    const fileLines = [
      `${item.entry.relativePath} [${item.entry.language}]`,
      ...item.entry.symbols
        .slice()
        .sort(
          (left, right) =>
            left.start.line - right.start.line || left.name.localeCompare(right.name),
        )
        .map(symbolLine),
    ];
    const candidate = `${fileLines.join("\n")}\n\n`;
    if (Buffer.byteLength(lines.join("\n") + candidate, "utf8") > maxCharacters) {
      truncated = true;
      break;
    }
    lines.push(...fileLines, "");
    includedFiles++;
    includedSymbols += item.entry.symbols.length;
  }

  if (includedFiles < ranked.length) {
    truncated = true;
  }
  return {
    text: lines.join("\n").trimEnd(),
    files: includedFiles,
    symbols: includedSymbols,
    truncated,
  };
}

export async function execute(rawInput: RepositoryMapInput): Promise<FeatureResult> {
  const input = repositoryMapSchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }
  const root = secureDirectory.path;
  const ignore = createIgnoreFilter(root);
  const files = collectFiles(root, ignore, root)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, input.max_files);
  const entries: FileEntry[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const relative = relativePath(root, file);
    const readResult = readSecureTextFile(file, root);
    if (!readResult.ok || readResult.content === undefined) {
      errors.push(`Cannot read ${relative}`);
      continue;
    }
    try {
      const parsed = await parseCode(readResult.content, { filePath: file });
      const info = extractCodeInfo(parsed.tree, parsed.languageInstance, parsed.language);
      entries.push({
        absolutePath: file,
        relativePath: relative,
        language: parsed.language,
        symbols: info.symbols.symbols,
        imports: info.imports.map((item) => item.source).filter(Boolean),
      });
    } catch {
      errors.push(`Cannot parse ${relative}`);
    }
  }

  const graph = buildFileGraph(entries, root, readPathAliasesCached(root));
  const ranked = rankFiles(entries, graph, input.focus);
  const rendered = renderMap(ranked, input.max_tokens);
  const mapSource = input.redact_secrets
    ? redactSourceText(rendered.text)
    : { text: rendered.text, redacted: false };
  const output: RepositoryMapOutput = {
    directory: root,
    files_analyzed: entries.length,
    files_included: rendered.files,
    symbols_included: rendered.symbols,
    token_budget: input.max_tokens,
    estimated_tokens: Math.ceil(Buffer.byteLength(mapSource.text, "utf8") / 4),
    truncated: rendered.truncated,
    secrets_redacted: mapSource.redacted,
    instruction_signals: scanInstructionSignals(rendered.text),
    focus: input.focus,
    map: mapSource.text,
    ranked_files: ranked.slice(0, 50).map((item) => ({
      path: item.entry.relativePath,
      language: item.entry.language,
      score: Number((item.rank + item.focusScore / 10).toFixed(6)),
      symbols: item.entry.symbols.length,
    })),
    errors,
  };

  return {
    success: true,
    message: `Repository map: ${String(rendered.files)} of ${String(entries.length)} files, ${String(rendered.symbols)} symbols${rendered.truncated ? " (truncated to token budget)" : ""}`,
    data: output,
  };
}

export const repositoryMapFeature: Feature<typeof repositoryMapSchema> = {
  name: "get_repository_map",
  title: "Get repository map",
  description:
    "Build a bounded, task-focusable repository map of important files and symbols. Ranking uses import-graph centrality plus optional path/symbol focus, so an agent can orient itself before reading source.",
  schema: repositoryMapSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  outputSchema: repositoryMapOutputSchema,
  execute,
};
