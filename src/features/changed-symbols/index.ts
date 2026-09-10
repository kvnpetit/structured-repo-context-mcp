import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import type { Symbol } from "@core/ast/types";
import { parseCode } from "@core/parser";
import { extractCodeInfo } from "@core/symbols";
import {
  createSafeLocalToolEnvironment,
  readSecureTextFile,
  resolveSecureDirectory,
  resolveSecureFile,
  safeErrorMessage,
} from "@core/security";
import type { Feature, FeatureResult } from "@features/types";
import { createFeatureResultSchema, positionSchema, symbolTypeSchema } from "@features/utils";

const execFileAsync = promisify(execFile);

export const changedSymbolsSchema = z.object({
  directory: z.string().optional().default(".").describe("Git repository root"),
  max_files: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .default(300)
    .describe("Maximum changed files to inspect"),
  max_symbols: z
    .number()
    .int()
    .positive()
    .max(5000)
    .optional()
    .default(1000)
    .describe("Maximum changed symbols to return"),
});

export type ChangedSymbolsInput = z.input<typeof changedSymbolsSchema>;

type ChangeStatus = "added" | "modified" | "deleted" | "unknown";

interface Hunk {
  start: number;
  end: number;
}

interface ChangedFile {
  path: string;
  status: ChangeStatus;
}

interface ChangedSymbol {
  file_path: string;
  status: ChangeStatus;
  name: string;
  type: Symbol["type"];
  start: Symbol["start"];
  end: Symbol["end"];
  signature?: string;
}

interface ChangedSymbolsOutput {
  directory: string;
  git_available: true;
  revision: string;
  files_changed: number;
  files_analyzed: number;
  files_truncated: boolean;
  symbols_truncated: boolean;
  symbols: ChangedSymbol[];
  files: {
    file_path: string;
    status: ChangeStatus;
    symbols_found: number;
  }[];
  errors: string[];
}

const changeStatusSchema = z.enum(["added", "modified", "deleted", "unknown"]);
const changedSymbolDataSchema = z
  .object({
    directory: z.string(),
    git_available: z.literal(true),
    revision: z.string(),
    files_changed: z.number().int().nonnegative(),
    files_analyzed: z.number().int().nonnegative(),
    files_truncated: z.boolean(),
    symbols_truncated: z.boolean(),
    symbols: z
      .object({
        file_path: z.string(),
        status: changeStatusSchema,
        name: z.string(),
        type: symbolTypeSchema,
        start: positionSchema,
        end: positionSchema,
        signature: z.string().optional(),
      })
      .strict()
      .array(),
    files: z
      .object({
        file_path: z.string(),
        status: changeStatusSchema,
        symbols_found: z.number().int().nonnegative(),
      })
      .strict()
      .array(),
    errors: z.string().array(),
  })
  .strict();

export const changedSymbolsOutputSchema = createFeatureResultSchema(changedSymbolDataSchema);

function parseNameStatus(value: string): ChangedFile[] {
  const records = value.split("\0");
  const files: ChangedFile[] = [];
  for (let index = 0; index + 1 < records.length; index += 2) {
    const rawStatus = records[index]?.trim();
    const filePath = records[index + 1]?.trim();
    if (!rawStatus || !filePath) {
      continue;
    }
    const status: ChangeStatus = rawStatus.startsWith("A")
      ? "added"
      : rawStatus.startsWith("M")
        ? "modified"
        : rawStatus.startsWith("D")
          ? "deleted"
          : "unknown";
    files.push({ path: filePath, status });
  }
  return files;
}

function parseUntracked(value: string): ChangedFile[] {
  return value
    .split("\0")
    .filter(Boolean)
    .map((filePath) => ({ path: filePath, status: "added" as const }));
}

function parseHunks(diff: string): Map<string, Hunk[]> {
  const hunks = new Map<string, Hunk[]>();
  let currentFile: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length);
      continue;
    }
    if (!currentFile || !line.startsWith("@@")) {
      continue;
    }
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (!match) {
      continue;
    }
    const start = Number(match[1]);
    const count = Number(match[2] ?? 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count)) {
      continue;
    }
    const entries = hunks.get(currentFile) ?? [];
    entries.push({
      start,
      end: start + Math.max(count, 1) - 1,
    });
    hunks.set(currentFile, entries);
  }
  return hunks;
}

function symbolTouchesHunk(symbol: Symbol, hunk: Hunk): boolean {
  return hunk.start <= symbol.end.line && hunk.end >= symbol.start.line;
}

async function git(directory: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", ["-C", directory, ...args], {
    cwd: directory,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    timeout: 15_000,
    env: {
      ...createSafeLocalToolEnvironment(),
      // This analysis is read-only: never wait for credentials, a pager, or
      // an editor, and never let a partial clone trigger an implicit fetch.
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      GIT_EDITOR: "true",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
    },
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function execute(rawInput: ChangedSymbolsInput): Promise<FeatureResult> {
  const input = changedSymbolsSchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }
  const root = secureDirectory.path;

  let revision: string;
  let tracked: ChangedFile[];
  let untracked: ChangedFile[];
  let diff: string;
  try {
    const [revisionResult, statusResult, untrackedResult, diffResult] = await Promise.all([
      git(root, ["rev-parse", "HEAD"]),
      git(root, [
        "diff",
        "-z",
        "--name-status",
        "--no-renames",
        "--diff-filter=ACDMUXB",
        "HEAD",
        "--",
      ]),
      git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
      git(root, [
        "--no-pager",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--unified=0",
        "HEAD",
        "--",
      ]),
    ]);
    revision = revisionResult.stdout.trim();
    tracked = parseNameStatus(statusResult.stdout);
    untracked = parseUntracked(untrackedResult.stdout);
    diff = diffResult.stdout;
  } catch (error) {
    return {
      success: false,
      error: `Git change analysis unavailable: ${safeErrorMessage(error, "directory is not a readable Git repository")}`,
    };
  }

  const byPath = new Map<string, ChangedFile>();
  for (const file of [...tracked, ...untracked]) {
    const normalized = file.path.replace(/\\/gu, "/");
    byPath.set(normalized, { ...file, path: normalized });
  }
  const files = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  const boundedFiles = files.slice(0, input.max_files);
  const hunks = parseHunks(diff);
  const output: ChangedSymbolsOutput = {
    directory: root,
    git_available: true,
    revision,
    files_changed: files.length,
    files_analyzed: 0,
    files_truncated: files.length > boundedFiles.length,
    symbols_truncated: false,
    symbols: [],
    files: [],
    errors: [],
  };

  for (const file of boundedFiles) {
    const absoluteFile = path.resolve(root, file.path);
    if (file.status === "deleted") {
      output.files.push({
        file_path: file.path,
        status: file.status,
        symbols_found: 0,
      });
      continue;
    }
    const secureFile = resolveSecureFile(absoluteFile, root);
    if (!secureFile.ok) {
      output.errors.push(`Cannot read ${file.path}`);
      continue;
    }
    const readResult = readSecureTextFile(secureFile.path, root);
    if (!readResult.ok || readResult.content === undefined) {
      output.errors.push(`Cannot read ${file.path}`);
      continue;
    }
    try {
      const parsed = await parseCode(readResult.content, {
        filePath: secureFile.path,
      });
      const info = extractCodeInfo(parsed.tree, parsed.languageInstance, parsed.language);
      const fileHunks = hunks.get(file.path) ?? [];
      const symbols = info.symbols.symbols.filter(
        (symbol) =>
          file.status === "added" ||
          fileHunks.length === 0 ||
          fileHunks.some((hunk) => symbolTouchesHunk(symbol, hunk)),
      );
      output.files_analyzed++;
      output.files.push({
        file_path: file.path,
        status: file.status,
        symbols_found: symbols.length,
      });
      for (const symbol of symbols) {
        if (output.symbols.length >= input.max_symbols) {
          output.symbols_truncated = true;
          break;
        }
        output.symbols.push({
          file_path: file.path,
          status: file.status,
          name: symbol.name,
          type: symbol.type,
          start: symbol.start,
          end: symbol.end,
          signature: symbol.signature,
        });
      }
    } catch {
      output.errors.push(`Cannot parse ${file.path}`);
    }
  }

  return {
    success: true,
    message: `Git changes: ${String(output.files_changed)} files, ${String(output.symbols.length)} touched symbols${output.files_truncated || output.symbols_truncated ? " (truncated)" : ""}`,
    data: output,
  };
}

export const changedSymbolsFeature: Feature<typeof changedSymbolsSchema> = {
  name: "get_changed_symbols",
  title: "Get changed symbols",
  description:
    "Read-only Git working-tree analysis that maps changed files and zero-context diff hunks to current source symbols. Includes untracked files, bounded output, and explicit limitations when symbols cannot be resolved.",
  schema: changedSymbolsSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  outputSchema: changedSymbolsOutputSchema,
  execute,
};
