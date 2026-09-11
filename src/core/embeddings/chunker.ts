/**
 * Code chunker for splitting source files into embeddable chunks
 *
 * Uses tree-sitter for semantic chunking based on symbols (functions, classes, etc.)
 * This produces much better embeddings than character-based splitting.
 */

import * as crypto from "node:crypto";
import type { Symbol } from "@core/ast/types";
import { parseCode } from "@core/parser";
import {
  getConfiguredLanguageFromPath,
  getIndexableExtensions,
  getIndexableSpecialFilenames,
  isIndexableFile,
} from "@core/parser/languages";
import { extractSymbols } from "@core/symbols";
import { logger } from "@utils";
import { isTextSplitterLanguage, splitCode } from "@core/fallback";

import type { CodeChunk, EmbeddingConfig } from "./types";

/**
 * Generate a unique ID for a chunk
 */
function generateChunkId(filePath: string, content: string, startLine: number): string {
  const hash = crypto
    .createHash("md5")
    .update(`${filePath}:${String(startLine)}:${content}`)
    .digest("hex")
    .slice(0, 12);
  return `chunk_${hash}`;
}

/**
 * Detect language from file extension
 */
export function detectLanguage(filePath: string): string {
  const language = getConfiguredLanguageFromPath(filePath);
  if (language === "tsx" || language === "c_sharp") {
    return language === "tsx" ? "typescript" : "csharp";
  }
  return language ?? "unknown";
}

/**
 * Get line number from byte offset
 */
function createLineLookup(content: string): (offset: number) => number {
  const starts = [0];
  for (let index = content.indexOf("\n"); index >= 0; ) {
    starts.push(index + 1);
    index = content.indexOf("\n", index + 1);
  }
  return (offset: number): number => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((starts[middle] ?? 0) <= offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return Math.max(1, low);
  };
}

/**
 * Extract code content for a symbol using its offsets
 */
function getSymbolContent(content: string, symbol: Symbol): string {
  return content.slice(symbol.start.offset, symbol.end.offset);
}

/**
 * Split large content into smaller chunks while respecting line boundaries
 */
interface SplitPart {
  content: string;
  startLine: number;
  endLine: number;
}

function splitLargeContent(
  content: string,
  maxSize: number,
  overlap: number,
  firstLine = 1,
): SplitPart[] {
  // Normalize line endings (handle CRLF and CR)
  const normalizedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (normalizedContent.length <= maxSize) {
    return [
      {
        content: normalizedContent,
        startLine: firstLine,
        endLine: firstLine + linesIn(normalizedContent) - 1,
      },
    ];
  }

  const chunks: SplitPart[] = [];
  const lines = normalizedContent.split("\n");
  let currentChunk: { text: string; line: number }[] = [];
  let currentSize = 0;

  for (const [index, line] of lines.entries()) {
    const lineSize = line.length + 1; // +1 for newline

    if (currentSize + lineSize > maxSize && currentChunk.length > 0) {
      const first = currentChunk[0];
      const last = currentChunk.at(-1);
      if (first !== undefined && last !== undefined) {
        chunks.push({
          content: currentChunk.map((entry) => entry.text).join("\n"),
          startLine: first.line,
          endLine: last.line,
        });
      }

      // Keep overlap lines
      const overlapLines: { text: string; line: number }[] = [];
      let overlapSize = 0;
      for (let i = currentChunk.length - 1; i >= 0 && overlapSize < overlap; i--) {
        const l = currentChunk[i];
        if (l !== undefined) {
          overlapLines.unshift(l);
          overlapSize += l.text.length + 1;
        }
      }
      currentChunk = overlapLines;
      currentSize = overlapSize;
    }

    currentChunk.push({ text: line, line: firstLine + index });
    currentSize += lineSize;
  }

  if (currentChunk.length > 0) {
    const first = currentChunk[0];
    const last = currentChunk.at(-1);
    if (first !== undefined && last !== undefined) {
      chunks.push({
        content: currentChunk.map((entry) => entry.text).join("\n"),
        startLine: first.line,
        endLine: last.line,
      });
    }
  }

  return chunks;
}

function linesIn(value: string): number {
  let lines = 1;
  for (let index = value.indexOf("\n"); index >= 0; ) {
    lines += 1;
    index = value.indexOf("\n", index + 1);
  }
  return lines;
}

/**
 * Create a chunk from content
 */
function createChunk(
  filePath: string,
  language: string,
  content: string,
  startLine: number,
  endLine: number,
  symbolName?: string,
  symbolType?: string,
): CodeChunk {
  return {
    id: generateChunkId(filePath, content, startLine),
    content,
    filePath,
    language,
    startLine,
    endLine,
    symbolName,
    symbolType,
  };
}

/**
 * Group consecutive small items (imports, constants, types) into a single chunk
 */
interface ContentRegion {
  content: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  symbolName?: string;
  symbolType?: string;
}

/**
 * Chunk a source file using tree-sitter for semantic boundaries
 *
 * Strategy:
 * 1. Parse file with tree-sitter and extract symbols
 * 2. Each function/class/method becomes its own chunk
 * 3. Code between symbols (imports, top-level code) is grouped together
 * 4. Large symbols are split at line boundaries if they exceed maxSize
 */
export async function chunkFile(
  filePath: string,
  content: string,
  config: Pick<EmbeddingConfig, "defaultChunkSize" | "defaultChunkOverlap">,
): Promise<CodeChunk[]> {
  const language = detectLanguage(filePath);
  const maxSize = config.defaultChunkSize;
  const overlap = config.defaultChunkOverlap;
  const lineAt = createLineLookup(content);

  // Try to parse with tree-sitter
  let symbols: Symbol[] = [];
  try {
    const parseResult = await parseCode(content, { filePath });
    const result = extractSymbols(
      parseResult.tree,
      parseResult.languageInstance,
      parseResult.language,
    );
    symbols = result.symbols;
  } catch (error) {
    logger.debug(
      `Tree-sitter parsing failed for ${filePath}, using fallback chunking: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    // Fallback to simple line-based chunking
    return fallbackChunk(filePath, content, language, maxSize, overlap);
  }

  // If no symbols found, use fallback
  if (symbols.length === 0) {
    return fallbackChunk(filePath, content, language, maxSize, overlap);
  }

  // Sort symbols by start offset
  const sortedSymbols = [...symbols].sort((a, b) => a.start.offset - b.start.offset);

  // Build regions: symbols + gaps between them
  const regions: ContentRegion[] = [];
  let lastEndOffset = 0;

  for (const symbol of sortedSymbols) {
    // Add gap before this symbol (if any significant content)
    if (symbol.start.offset > lastEndOffset) {
      const gapContent = content.slice(lastEndOffset, symbol.start.offset).trim();
      if (gapContent.length > 0) {
        regions.push({
          content: content.slice(lastEndOffset, symbol.start.offset),
          startOffset: lastEndOffset,
          endOffset: symbol.start.offset,
          startLine: lineAt(lastEndOffset),
          endLine: lineAt(symbol.start.offset),
        });
      }
    }

    // Add symbol region
    const symbolContent = getSymbolContent(content, symbol);
    regions.push({
      content: symbolContent,
      startOffset: symbol.start.offset,
      endOffset: symbol.end.offset,
      startLine: symbol.start.line,
      endLine: symbol.end.line,
      symbolName: symbol.name,
      symbolType: symbol.type,
    });

    lastEndOffset = Math.max(lastEndOffset, symbol.end.offset);
  }

  // Add trailing content after last symbol
  if (lastEndOffset < content.length) {
    const trailingContent = content.slice(lastEndOffset).trim();
    if (trailingContent.length > 0) {
      regions.push({
        content: content.slice(lastEndOffset),
        startOffset: lastEndOffset,
        endOffset: content.length,
        startLine: lineAt(lastEndOffset),
        endLine: lineAt(content.length),
      });
    }
  }

  // Convert regions to chunks, splitting large ones
  const chunks: CodeChunk[] = [];

  for (const region of regions) {
    const leftTrimmed = region.content.trimStart();
    const leadingCharacters = region.content.length - leftTrimmed.length;
    const regionContent = leftTrimmed.trimEnd();
    if (regionContent.length === 0) {
      continue;
    }
    const regionStartLine = lineAt(region.startOffset + leadingCharacters);
    const regionEndLine = regionStartLine + linesIn(regionContent) - 1;

    if (regionContent.length <= maxSize) {
      // Small enough, create single chunk
      chunks.push(
        createChunk(
          filePath,
          language,
          regionContent,
          regionStartLine,
          regionEndLine,
          region.symbolName,
          region.symbolType,
        ),
      );
    } else {
      // Too large, split it
      const parts = splitLargeContent(regionContent, maxSize, overlap, regionStartLine);

      for (const part of parts) {
        chunks.push(
          createChunk(
            filePath,
            language,
            part.content,
            part.startLine,
            part.endLine,
            region.symbolName,
            region.symbolType,
          ),
        );
      }
    }
  }

  return chunks;
}

/**
 * Fallback chunking when tree-sitter fails or finds no symbols
 * Uses simple line-based splitting
 */
async function fallbackChunk(
  filePath: string,
  content: string,
  language: string,
  maxSize: number,
  overlap: number,
): Promise<CodeChunk[]> {
  // Handle empty content
  if (content.trim().length === 0) {
    return [];
  }

  if (isTextSplitterLanguage(language)) {
    const result = await splitCode(content, language, {
      chunkSize: maxSize,
      chunkOverlap: overlap,
    });
    return result.chunks.map((chunk) =>
      createChunk(filePath, language, chunk.content, chunk.startLine, chunk.endLine),
    );
  }

  const chunks: CodeChunk[] = [];
  const parts = splitLargeContent(content, maxSize, overlap);

  for (const part of parts) {
    chunks.push(createChunk(filePath, language, part.content, part.startLine, part.endLine));
  }

  return chunks;
}

/**
 * Chunk multiple files
 */
export async function chunkFiles(
  files: { path: string; content: string }[],
  config: Pick<EmbeddingConfig, "defaultChunkSize" | "defaultChunkOverlap">,
): Promise<CodeChunk[]> {
  const allChunks: CodeChunk[] = [];

  for (const file of files) {
    const chunks = await chunkFile(file.path, file.content, config);
    allChunks.push(...chunks);
  }

  return allChunks;
}

/**
 * Supported file extensions for indexing
 */
export const SUPPORTED_EXTENSIONS = getIndexableExtensions();
export const SUPPORTED_FILENAMES = getIndexableSpecialFilenames();

/**
 * Check if a file should be indexed
 */
export function shouldIndexFile(filePath: string): boolean {
  return isIndexableFile(filePath);
}
