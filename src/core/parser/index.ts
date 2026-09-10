/**
 * Tree-sitter parser module
 *
 * Provides code parsing functionality using web-tree-sitter
 * WASM files are loaded from local assets directory for minimal bundle size
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { Language, type Node, Parser, type Point, type Tree } from "web-tree-sitter";

import type { ASTNode, Position } from "@core/ast/types";
import { getAssetsDir, registerCache } from "@core/utils";

import {
  getLanguageByName,
  getLanguageFromPath,
  getGrammarMetadata,
  type GrammarMetadata,
  type LanguageConfig,
} from "./languages";

// Re-export language utilities
export * from "./languages";

// Re-export types for external use
export type { Language, Node, Point, Tree };

/**
 * Parser initialization state
 */
let isInitialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Cache for loaded languages
 */
const languageCache = new Map<string, Language>();
const languageLoadPromises = new Map<string, Promise<Language>>();
const languageCacheInvalidators = new Set<() => void>();

/**
 * Parser instance (reused)
 */
let parser: Parser | null = null;
const DEFAULT_MAX_AST_NODES = 10_000;

/**
 * Initialize the Tree-sitter WASM module
 * Must be called before any parsing operations
 */
export async function initializeParser(): Promise<void> {
  if (isInitialized) {
    return;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    // web-tree-sitter loads its WASM from node_modules automatically
    await Parser.init();
    parser = new Parser();
    isInitialized = true;
  })();

  return initPromise;
}

/**
 * Check if the parser is initialized
 */
export function isParserInitialized(): boolean {
  return isInitialized;
}

/** Register dependent native caches that must be cleared before languages. */
export function registerLanguageCacheInvalidator(invalidator: () => void): () => void {
  languageCacheInvalidators.add(invalidator);
  return () => languageCacheInvalidators.delete(invalidator);
}

/**
 * Get or create a parser instance
 */
async function getParser(): Promise<Parser> {
  await initializeParser();
  if (!parser) {
    throw new Error("Parser not initialized");
  }
  return parser;
}

/**
 * Load a language grammar from local assets
 */
async function loadLanguage(config: LanguageConfig): Promise<Language> {
  const cacheKey = config.name;

  // Check cache first
  const cached = languageCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = languageLoadPromises.get(cacheKey);
  if (pending !== undefined) {
    return pending;
  }

  await initializeParser();

  // Load WASM from local assets directory
  const assetsDir = getAssetsDir();
  const wasmPath = join(assetsDir, "wasm", config.wasm);

  if (!existsSync(wasmPath)) {
    throw new Error(`WASM file not found for language ${config.name}: ${wasmPath}`);
  }

  const loadPromise = Language.load(wasmPath)
    .then((language) => {
      languageCache.set(cacheKey, language);
      return language;
    })
    .finally(() => {
      languageLoadPromises.delete(cacheKey);
    });
  languageLoadPromises.set(cacheKey, loadPromise);
  return loadPromise;
}

/**
 * Parse result
 */
export interface ParseResult {
  /** The Tree-sitter tree */
  tree: Tree;
  /** Language that was used */
  language: string;
  /** The parser instance (for queries) */
  parser: Parser;
  /** The language instance (for queries) */
  languageInstance: Language;
  /** Exact local identity of the grammar asset used for this parse. */
  grammar?: GrammarMetadata;
}

/**
 * Parse options
 */
export interface ParseOptions {
  /** Language name (auto-detected from file path if not provided) */
  language?: string;
  /** File path (for language detection) */
  filePath?: string;
}

/**
 * Parse code content
 */
export async function parseCode(content: string, options: ParseOptions = {}): Promise<ParseResult> {
  const { language, filePath } = options;

  // Determine language config
  let config: LanguageConfig | undefined;

  if (language) {
    config = getLanguageByName(language);
    if (!config) {
      throw new Error(`Unsupported language: ${language}`);
    }
  } else if (filePath) {
    config = getLanguageFromPath(filePath);
    if (!config) {
      throw new Error(`Could not detect language for file: ${filePath}`);
    }
  } else {
    throw new Error("Either language or filePath must be provided");
  }

  // Load the language grammar
  const languageInstance = await loadLanguage(config);

  // Get parser and set language
  const parserInstance = await getParser();
  parserInstance.setLanguage(languageInstance);

  // Parse the content
  const tree = parserInstance.parse(content);

  if (!tree) {
    throw new Error("Failed to parse content");
  }

  return {
    tree,
    language: config.name,
    parser: parserInstance,
    languageInstance,
    grammar: getGrammarMetadata(config.name),
  };
}

/**
 * Convert Tree-sitter position to our Position type
 */
export function toPosition(point: Point, offset: number): Position {
  return {
    line: point.row + 1, // Convert 0-based to 1-based
    column: point.column,
    offset,
  };
}

function boundNodeText(
  text: string,
  maxTextBytes: number | undefined,
): { text: string; truncated: boolean } {
  if (maxTextBytes === undefined || Buffer.byteLength(text, "utf8") <= maxTextBytes) {
    return { text, truncated: false };
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxTextBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { text: text.slice(0, low), truncated: true };
}

/**
 * Convert Tree-sitter node to ASTNode
 */
export function toASTNode(
  node: Node,
  maxDepth?: number,
  currentDepth = 0,
  maxTextBytes?: number,
  maxNodes = DEFAULT_MAX_AST_NODES,
): ASTNode {
  // Tree-sitter fields usually point to nodes that are also present in
  // `namedChildren`. Cache each node/depth pair so representing both views
  // stays linear instead of recursively cloning the same subtrees for every
  // field. The depth is part of the key because callers can intentionally ask
  // for different depth limits.
  const cache = new WeakMap<Node, Map<number, ASTNode>>();

  const nodeLimit = Math.max(1, maxNodes);
  let extractedNodes = 0;

  function convert(current: Node, depth: number): ASTNode | undefined {
    const cachedByDepth = cache.get(current);
    const cached = cachedByDepth?.get(depth);
    if (cached !== undefined) {
      return cached;
    }
    if (extractedNodes >= nodeLimit) {
      return undefined;
    }
    extractedNodes++;

    const bounded = boundNodeText(current.text, maxTextBytes);
    const astNode: ASTNode = {
      type: current.type,
      text: bounded.text,
      start: toPosition(current.startPosition, current.startIndex),
      end: toPosition(current.endPosition, current.endIndex),
      isNamed: current.isNamed,
      ...(bounded.truncated ? { text_truncated: true } : {}),
    };
    const entries = cachedByDepth ?? new Map<number, ASTNode>();
    entries.set(depth, astNode);
    cache.set(current, entries);

    if (maxDepth !== undefined && depth >= maxDepth) {
      return astNode;
    }

    // Add children if present
    if (current.childCount > 0) {
      const namedChildren = current.namedChildren;
      if (namedChildren.length > 0) {
        const children: ASTNode[] = [];
        for (const child of namedChildren) {
          const converted = convert(child, depth + 1);
          if (converted === undefined) {
            astNode.children_truncated = true;
            break;
          }
          children.push(converted);
        }
        if (children.length > 0) {
          astNode.children = children;
        }
      }
    }

    // Add named fields using the language's field names
    const fields: Record<string, ASTNode | ASTNode[]> = {};
    for (const fieldName of current.tree.language.fields) {
      if (fieldName) {
        const fieldNode = current.childForFieldName(fieldName);
        if (fieldNode) {
          const converted = convert(fieldNode, depth + 1);
          if (converted === undefined) {
            astNode.children_truncated = true;
            break;
          }
          fields[fieldName] = converted;
        }
      }
    }

    if (Object.keys(fields).length > 0) {
      astNode.fields = fields;
    }

    return astNode;
  }

  const root = convert(node, currentDepth);
  if (root === undefined) {
    throw new Error("AST node budget must allow at least one node");
  }
  return root;
}

/**
 * Get the root ASTNode from a parse result
 */
export function getASTRoot(
  parseResult: { tree: Tree },
  maxDepth?: number,
  maxTextBytes?: number,
  maxNodes = DEFAULT_MAX_AST_NODES,
): ASTNode {
  return toASTNode(parseResult.tree.rootNode, maxDepth, 0, maxTextBytes, maxNodes);
}

/**
 * Count nodes in the tree
 */
export function countNodes(node: Node, maxNodes = Number.POSITIVE_INFINITY): number {
  const limit = Math.max(1, maxNodes);
  let count = 0;
  const pending: Node[] = [node];
  while (pending.length > 0 && count < limit) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    count++;
    const children = current.namedChildren;
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index];
      if (child !== undefined) {
        pending.push(child);
      }
    }
  }
  return count;
}

/**
 * Clear the language cache (useful for testing)
 */
export function clearLanguageCache(): void {
  for (const invalidate of languageCacheInvalidators) {
    invalidate();
  }
  languageCache.clear();
  languageLoadPromises.clear();
}

/**
 * Reset the parser state (useful for testing)
 */
export function resetParser(): void {
  for (const invalidate of languageCacheInvalidators) {
    invalidate();
  }
  languageCache.clear();
  languageLoadPromises.clear();
  parser = null;
  isInitialized = false;
  initPromise = null;
}

// Register caches for centralized clearing
registerCache("parser:languageCache", clearLanguageCache);
registerCache("parser:state", resetParser);
