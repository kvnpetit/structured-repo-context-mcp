import * as fs from "node:fs";
import * as path from "node:path";

import { collectFiles, createIgnoreFilter } from "@core/files";
import { parseCode } from "@core/parser";
import {
  createPaginationCursor,
  createPaginationScope,
  decodePaginationCursor,
} from "@core/pagination";
import { extractCodeInfo } from "@core/symbols";
import {
  mergeInstructionSignals,
  redactSourceText,
  readSecureTextFile,
  resolveSecureDirectory,
  resolveSecurePath,
  scanInstructionSignals,
} from "@core/security";
import type { Export, Import, Position, Symbol } from "@core/ast/types";
import type { Feature, FeatureResult } from "@features/types";
import {
  findSymbolsOutputSchema,
  findSymbolsSchema,
  type FindSymbolsInput,
  type NavigationMatch,
  type NavigationOutput,
} from "./schema";

export {
  findSymbolsOutputSchema,
  findSymbolsSchema,
  type FindSymbolsInput,
} from "./schema";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stringIndexAtByteOffset(content: string, byteOffset: number): number {
  if (byteOffset <= 0) {
    return 0;
  }
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
  const safeIndex = Math.max(0, Math.min(index, content.length));
  const prefix = content.slice(0, safeIndex);
  const newline = prefix.lastIndexOf("\n");
  return {
    line: (prefix.match(/\n/g) ?? []).length + 1,
    column: safeIndex - newline - 1,
    offset: Buffer.byteLength(prefix, "utf8"),
  };
}

function snippetAt(content: string, start: number, end: number): string {
  const startIndex = stringIndexAtByteOffset(content, start);
  const endIndex = stringIndexAtByteOffset(content, end);
  const contextStart = Math.max(0, startIndex - 100);
  const contextEnd = Math.min(content.length, Math.max(endIndex, startIndex) + 180);
  return content.slice(contextStart, contextEnd).trim();
}

function matchesQuery(value: string, query: string): boolean {
  return query.length === 0 || value.toLowerCase().includes(query.toLowerCase());
}

function extractTextImports(content: string): Import[] {
  const imports: Import[] = [];
  const pattern = /\bimport\s+([^;\n]*?)(?:\s+from\s+)?["']([^"']+)["']/gu;
  for (const match of content.matchAll(pattern)) {
    const statement = match[0];
    const clause = match[1] ?? "";
    const source = match[2] ?? "";
    const index = match.index;
    const names = clause
      .replace(/^type\s+/u, "")
      .replace(/[{}]/g, "")
      .split(",")
      .map((value) => value.trim().split(/\s+as\s+/u)[0] ?? "")
      .filter(Boolean)
      .map((name) => ({ name }));
    imports.push({
      source,
      names,
      start: positionAt(content, index),
      end: positionAt(content, index + statement.length),
    });
  }
  return imports;
}

function definitionMatch(symbol: Symbol, filePath: string, content: string): NavigationMatch {
  return {
    kind: "definition",
    name: symbol.name,
    type: symbol.type,
    file_path: filePath,
    start: symbol.start,
    end: symbol.end,
    snippet: snippetAt(content, symbol.start.offset, symbol.end.offset),
    signature: symbol.signature,
  };
}

function importMatch(item: Import, filePath: string, content: string): NavigationMatch {
  return {
    kind: "import",
    name: item.names.map((name) => name.alias ?? name.name).join(", ") || item.source,
    file_path: filePath,
    start: item.start,
    end: item.end,
    snippet: snippetAt(content, item.start.offset, item.end.offset),
    source: item.source,
  };
}

function exportMatch(item: Export, filePath: string, content: string): NavigationMatch {
  return {
    kind: "export",
    name: item.name,
    file_path: filePath,
    start: item.start,
    end: item.end,
    snippet: snippetAt(content, item.start.offset, item.end.offset),
    source: item.source,
  };
}

function referenceMatches(query: string, filePath: string, content: string): NavigationMatch[] {
  if (query.length === 0) {
    return [];
  }
  const pattern = new RegExp(`\\b${escapeRegExp(query)}\\b`, "giu");
  return Array.from(content.matchAll(pattern), (match) => {
    const index = match.index;
    const start = positionAt(content, index);
    const end = positionAt(content, index + match[0].length);
    return {
      kind: "reference" as const,
      name: match[0],
      file_path: filePath,
      start,
      end,
      snippet: snippetAt(content, start.offset, end.offset),
    };
  });
}

export async function execute(rawInput: FindSymbolsInput): Promise<FeatureResult> {
  const input = findSymbolsSchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }
  const absoluteDirectory = secureDirectory.path;

  let files: string[];
  let filesTruncated = false;
  if (input.file_path) {
    const secureFile = resolveSecurePath(resolvePath(absoluteDirectory, input.file_path), {
      kind: "file",
      root: absoluteDirectory,
      allowMissing: true,
    });
    if (!secureFile.ok) {
      return { success: false, error: secureFile.error };
    }
    files = [secureFile.path];
  } else {
    const ignore = createIgnoreFilter(absoluteDirectory);
    const allFiles = collectFiles(absoluteDirectory, ignore, absoluteDirectory).sort(
      (left, right) => left.localeCompare(right),
    );
    files = allFiles.slice(0, input.max_files);
    filesTruncated = allFiles.length > files.length;
  }

  const paginationScope = createPaginationScope({
    directory: absoluteDirectory,
    file_path: input.file_path ?? null,
    query: input.query,
    mode: input.mode,
    max_files: input.max_files,
    files: files.map((file) => fileScopeIdentity(absoluteDirectory, file)),
  });
  const cursorResult = decodePaginationCursor(input.cursor, paginationScope);
  if (!cursorResult.ok) {
    return { success: false, error: cursorResult.error };
  }
  const cursorOffset = cursorResult.offset;

  const output: NavigationOutput = {
    query: input.query,
    mode: input.mode,
    files_analyzed: 0,
    files_truncated: filesTruncated,
    truncated: false,
    matches: [],
    cursor_offset: cursorOffset,
    source_is_untrusted: true,
    secrets_redacted: false,
    instruction_signals: scanInstructionSignals(""),
    errors: [],
  };
  const instructionScans: ReturnType<typeof scanInstructionSignals>[] = [];

  let matchIndex = 0;
  const appendMatches = (matches: NavigationMatch[]): boolean => {
    for (const match of matches) {
      const currentIndex = matchIndex;
      matchIndex += 1;
      if (currentIndex < cursorOffset) {
        continue;
      }
      if (output.matches.length >= input.limit) {
        return true;
      }
      output.matches.push(match);
    }
    return false;
  };
  let nextCursorOffset: number | undefined;

  for (const file of files) {
    const readResult = readSecureTextFile(file, absoluteDirectory);
    if (!readResult.ok || readResult.content === undefined) {
      output.errors.push(`Cannot read ${relativePath(absoluteDirectory, file)}`);
      continue;
    }
    const content = readResult.content;
    instructionScans.push(
      scanInstructionSignals(content, {
        source: relativePath(absoluteDirectory, file),
      }),
    );
    output.files_analyzed++;
    const relativeFile = relativePath(absoluteDirectory, file);
    let stopProcessingFile = false;
    try {
      const parsed = await parseCode(content, { filePath: file });
      const info = extractCodeInfo(parsed.tree, parsed.languageInstance, parsed.language);
      const imports =
        info.imports.length > 0 && info.imports.some((item) => item.source.length > 0)
          ? info.imports
          : extractTextImports(content);

      if (input.mode === "definitions" || input.mode === "all") {
        const stopped = appendMatches(
          info.symbols.symbols
            .filter((symbol) => matchesQuery(symbol.name, input.query))
            .map((symbol) => definitionMatch(symbol, relativeFile, content)),
        );
        if (stopped) {
          stopProcessingFile = true;
        }
      }
      if (!stopProcessingFile && (input.mode === "imports" || input.mode === "all")) {
        const stopped = appendMatches(
          imports
            .filter(
              (item) =>
                matchesQuery(item.source, input.query) ||
                item.names.some((name) => matchesQuery(name.name, input.query)),
            )
            .map((item) => importMatch(item, relativeFile, content)),
        );
        if (stopped) {
          stopProcessingFile = true;
        }
      }
      if (!stopProcessingFile && (input.mode === "exports" || input.mode === "all")) {
        const stopped = appendMatches(
          info.exports
            .filter(
              (item) =>
                matchesQuery(item.name, input.query) ||
                matchesQuery(item.source ?? "", input.query),
            )
            .map((item) => exportMatch(item, relativeFile, content)),
        );
        if (stopped) {
          stopProcessingFile = true;
        }
      }
      if (!stopProcessingFile && (input.mode === "references" || input.mode === "all")) {
        const stopped = appendMatches(referenceMatches(input.query, relativeFile, content));
        if (stopped) {
          stopProcessingFile = true;
        }
      }
    } catch {
      output.errors.push(`Cannot parse ${relativeFile}`);
    }

    if (stopProcessingFile) {
      nextCursorOffset = cursorOffset + output.matches.length;
      output.truncated = true;
      break;
    }
  }

  if (input.redact_secrets) {
    output.matches = output.matches.map((match) => {
      const snippet = redactSourceText(match.snippet);
      const source = match.source === undefined ? undefined : redactSourceText(match.source);
      output.secrets_redacted ||= snippet.redacted || (source?.redacted ?? false);
      return {
        ...match,
        snippet: snippet.text,
        ...(source === undefined ? {} : { source: source.text }),
      };
    });
  }

  output.truncated ||= filesTruncated;
  output.instruction_signals = mergeInstructionSignals(instructionScans);
  if (nextCursorOffset !== undefined) {
    output.next_cursor = createPaginationCursor(paginationScope, nextCursorOffset);
  }

  const message = `Found ${String(output.matches.length)} ${input.mode} match${output.matches.length === 1 ? "" : "es"}`;
  return { success: true, message, data: output };
}

function resolvePath(directory: string, filePath: string): string {
  return path.resolve(directory, filePath);
}

function relativePath(directory: string, filePath: string): string {
  return path.relative(directory, filePath).replace(/\\/g, "/");
}

function fileScopeIdentity(
  directory: string,
  filePath: string,
): {
  path: string;
  size: number | "unavailable";
  modified: number | "unavailable";
} {
  try {
    const stats = fs.statSync(filePath);
    return {
      path: relativePath(directory, filePath),
      size: stats.size,
      modified: Math.trunc(stats.mtimeMs),
    };
  } catch {
    return {
      path: relativePath(directory, filePath),
      size: "unavailable",
      modified: "unavailable",
    };
  }
}

export const findSymbolsFeature: Feature<typeof findSymbolsSchema> = {
  name: "find_symbols",
  title: "Find symbols and references",
  description:
    "Read-only code navigation across a project: find symbol definitions, textual references, imports, and exports with precise byte offsets and bounded snippets.",
  schema: findSymbolsSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  outputSchema: findSymbolsOutputSchema,
  execute,
};
