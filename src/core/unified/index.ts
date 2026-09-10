/**
 * Unified Parser Module
 *
 * Provides a single interface for code parsing with automatic fallback:
 * 1. Tree-sitter (AST parsing) - for supported languages
 * 2. LangChain text splitter - for unsupported languages but known file types
 * 3. Generic text splitting - for any other text files
 */
import { readFileSync } from "node:fs";

import type { Language, Tree } from "web-tree-sitter";

import type { ASTNode } from "@core/ast/types";
import { isTextSplitterLanguage, splitCode, type TextChunk } from "@core/fallback";
import { getASTRoot, isLanguageSupported, parseCode } from "@core/parser";
import type { GrammarMetadata } from "@core/parser";
import { extractSymbolsFromTags, findClasses, findFunctions } from "@core/queries";
import { DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE, SKIP_KEYWORDS } from "@core/constants";
import { detectLanguage, isBinaryFile } from "./languages";

export {
  canParse,
  clearUnifiedCache,
  detectLanguage,
  getParsingCapabilities,
  getSupportedLanguagesInfo,
  isBinaryFile,
} from "./languages";

/**
 * Unified parse result - works for both Tree-sitter and fallback
 */
export interface UnifiedParseResult {
  /** Parsing method used */
  method: "tree-sitter" | "langchain" | "generic";
  /** Language detected */
  language: string;
  /** File path */
  filePath: string;
  /** Original content */
  content: string;
  /** Line count */
  lineCount: number;
  /** Exact local Tree-sitter grammar identity when Tree-sitter was used. */
  grammar?: GrammarMetadata;

  // Tree-sitter specific (only when method === "tree-sitter")
  /** Tree-sitter tree (if available) */
  tree?: Tree;
  /** Language instance (if available) */
  languageInstance?: Language;
  /** AST root node (if available) */
  ast?: ASTNode;

  // Fallback specific (only when method !== "tree-sitter")
  /** Text chunks (if using fallback) */
  chunks?: TextChunk[];
}

/**
 * Unified symbol extraction result
 */
export interface UnifiedSymbols {
  /** Extraction method used */
  method: "tree-sitter" | "regex";
  /** Functions found */
  functions: UnifiedSymbol[];
  /** Classes found */
  classes: UnifiedSymbol[];
  /** All symbols */
  all: UnifiedSymbol[];
}

/**
 * Unified symbol representation
 */
export interface UnifiedSymbol {
  name: string;
  type: "function" | "method" | "class" | "interface" | "module" | "variable";
  line: number;
  endLine?: number;
  signature?: string;
  documentation?: string;
}

/**
 * Parse options
 */
export interface UnifiedParseOptions {
  /** Force a specific language (skip auto-detection) */
  language?: string;
  /** Include AST in result (Tree-sitter only, can be verbose) */
  includeAst?: boolean;
  /** Max AST depth (Tree-sitter only) */
  astMaxDepth?: number;
  /** Max AST nodes materialized (Tree-sitter only) */
  astMaxNodes?: number;
  /** Chunk size for fallback splitting */
  chunkSize?: number;
  /** Chunk overlap for fallback splitting */
  chunkOverlap?: number;
}

/**
 * Extract a meaningful name from AST node text, skipping keywords
 */
function extractNameFromNode(text: string): string {
  // Split by common delimiters
  const parts = text.split(/[(\s{<:=[\]]/);

  // Find first non-keyword identifier
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed && !SKIP_KEYWORDS.has(trimmed.toLowerCase()) && /^[a-zA-Z_]/.test(trimmed)) {
      return trimmed;
    }
  }

  return "anonymous";
}

/**
 * Parse a file with automatic fallback
 *
 * 1. If Tree-sitter supports the language → full AST parsing
 * 2. If LangChain supports the language → text splitting with language separators
 * 3. LangChain generic → text splitting with default separators
 * 4. If all fail → returns undefined (file is ignored)
 */
export async function parseFile(
  filePath: string,
  options: UnifiedParseOptions = {},
): Promise<UnifiedParseResult | undefined> {
  // Check for binary files - ignore them
  if (isBinaryFile(filePath)) {
    return undefined;
  }

  // Read file content
  let content: string;
  try {
    const rawContent = readFileSync(filePath, "utf-8");
    // Normalize line endings (handle CRLF and CR)
    content = rawContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  } catch {
    // Cannot read file - ignore
    return undefined;
  }

  const lineCount = content.split("\n").length;

  // Detect language
  const language = options.language ?? detectLanguage(filePath);

  // Try Tree-sitter first
  if (isLanguageSupported(language)) {
    try {
      const parseResult = await parseCode(content, { language });

      const result: UnifiedParseResult = {
        method: "tree-sitter",
        language: parseResult.language,
        filePath,
        content,
        lineCount,
        grammar: parseResult.grammar,
        tree: parseResult.tree,
        languageInstance: parseResult.languageInstance,
      };

      // Include AST if requested
      if (options.includeAst) {
        result.ast = getASTRoot(parseResult, options.astMaxDepth, undefined, options.astMaxNodes);
      }

      return result;
    } catch {
      // Tree-sitter failed, fall through to LangChain
    }
  }

  // Try LangChain with detected language
  const { chunkSize = DEFAULT_CHUNK_SIZE, chunkOverlap = DEFAULT_CHUNK_OVERLAP } = options;

  if (isTextSplitterLanguage(language)) {
    try {
      const splitResult = await splitCode(content, language, {
        chunkSize,
        chunkOverlap,
      });

      return {
        method: "langchain",
        language,
        filePath,
        content,
        lineCount,
        chunks: splitResult.chunks,
      };
    } catch {
      // LangChain with language failed, try generic
    }
  }

  // Try LangChain generic
  try {
    const splitResult = await splitCode(content, "generic", {
      chunkSize,
      chunkOverlap,
    });

    return {
      method: "generic",
      language,
      filePath,
      content,
      lineCount,
      chunks: splitResult.chunks,
    };
  } catch {
    // All methods failed - ignore file
    return undefined;
  }
}

/**
 * Parse content directly (without file)
 *
 * Returns undefined if content cannot be parsed
 */
export async function parseContent(
  content: string,
  language: string,
  options: Omit<UnifiedParseOptions, "language"> = {},
): Promise<Omit<UnifiedParseResult, "filePath"> | undefined> {
  // Normalize line endings (handle CRLF and CR)
  const normalizedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lineCount = normalizedContent.split("\n").length;

  // Try Tree-sitter first
  if (isLanguageSupported(language)) {
    try {
      const parseResult = await parseCode(content, { language });

      const result: Omit<UnifiedParseResult, "filePath"> = {
        method: "tree-sitter",
        language: parseResult.language,
        content,
        lineCount,
        grammar: parseResult.grammar,
        tree: parseResult.tree,
        languageInstance: parseResult.languageInstance,
      };

      if (options.includeAst) {
        result.ast = getASTRoot(parseResult, options.astMaxDepth, undefined, options.astMaxNodes);
      }

      return result;
    } catch {
      // Tree-sitter failed, fall through to LangChain
    }
  }

  // Try LangChain with detected language
  const { chunkSize = DEFAULT_CHUNK_SIZE, chunkOverlap = DEFAULT_CHUNK_OVERLAP } = options;

  if (isTextSplitterLanguage(language)) {
    try {
      const splitResult = await splitCode(content, language, {
        chunkSize,
        chunkOverlap,
      });

      return {
        method: "langchain",
        language,
        content,
        lineCount,
        chunks: splitResult.chunks,
      };
    } catch {
      // LangChain with language failed, try generic
    }
  }

  // Try LangChain generic
  try {
    const splitResult = await splitCode(content, "generic", {
      chunkSize,
      chunkOverlap,
    });

    return {
      method: "generic",
      language,
      content,
      lineCount,
      chunks: splitResult.chunks,
    };
  } catch {
    // All methods failed - ignore
    return undefined;
  }
}

/**
 * Extract symbols with automatic fallback
 *
 * 1. Tree-sitter → accurate AST-based extraction
 * 2. Regex fallback → best-effort pattern matching
 */
export function extractSymbols(result: UnifiedParseResult): UnifiedSymbols {
  // Tree-sitter path
  if (result.method === "tree-sitter" && result.tree && result.languageInstance) {
    const { definitions } = extractSymbolsFromTags(
      result.tree,
      result.languageInstance,
      result.language,
    );

    const functions: UnifiedSymbol[] = [];
    const classes: UnifiedSymbol[] = [];
    const all: UnifiedSymbol[] = [];

    for (const def of definitions) {
      const symbol: UnifiedSymbol = {
        name: def.name,
        type: def.kind as UnifiedSymbol["type"],
        line: def.node.start.line,
        endLine: def.node.end.line,
        documentation: def.documentation,
      };

      all.push(symbol);

      if (def.kind === "function" || def.kind === "method") {
        functions.push(symbol);
      } else if (def.kind === "class" || def.kind === "interface" || def.kind === "module") {
        classes.push(symbol);
      }
    }

    // If tags.scm didn't find anything, try direct AST queries
    if (functions.length === 0) {
      const funcNodes = findFunctions(result.tree, result.languageInstance, result.language);
      for (const node of funcNodes) {
        const symbol: UnifiedSymbol = {
          name: extractNameFromNode(node.text),
          type: "function",
          line: node.start.line,
          endLine: node.end.line,
        };
        functions.push(symbol);
        all.push(symbol);
      }
    }

    if (classes.length === 0) {
      const classNodes = findClasses(result.tree, result.languageInstance, result.language);
      for (const node of classNodes) {
        const symbol: UnifiedSymbol = {
          name: extractNameFromNode(node.text),
          type: "class",
          line: node.start.line,
          endLine: node.end.line,
        };
        classes.push(symbol);
        all.push(symbol);
      }
    }

    return { method: "tree-sitter", functions, classes, all };
  }

  // LangChain fallback - no symbol extraction (text splitting only)
  return { method: "regex", functions: [], classes: [], all: [] };
}
