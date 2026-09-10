/**
 * Call graph extraction and storage
 *
 * Extracts function call relationships from code using tree-sitter
 * to build a graph showing which functions call which.
 *
 * Features:
 * - Persistent caching in .src-index/call-graph.json
 * - Hash-based invalidation for changed files
 */

import { Query } from "web-tree-sitter";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Position, Symbol } from "@core/ast/types";
import {
  computeCallGraphHash,
  loadCallGraphCache,
  saveCallGraphCache,
} from "@core/embeddings/callgraph-cache";
import type {
  CallGraph,
  CallGraphNode,
  FileCallData,
  FunctionCall,
} from "@core/embeddings/callgraph-types";
import { parseCode, type ParseResult } from "@core/parser";
import { extractSymbols } from "@core/symbols";
import { registerCache } from "@core/utils";
import { logger } from "@utils";

export type { CallGraph, CallGraphNode, FunctionCall } from "./callgraph-types";
export { formatCallContext, getCallContext } from "./callgraph-context";

const callGraphCache = new Map<string, FileCallData>();

/**
 * Clear the call graph cache
 */
export function clearCallGraphCache(): void {
  callGraphCache.clear();
}

// Register cache for centralized clearing
registerCache("embeddings:callGraphCache", clearCallGraphCache);

/**
 * Extract function calls from a tree-sitter node
 */
function extractCallsFromTree(
  tree: ParseResult["tree"],
  languageInstance: ParseResult["languageInstance"],
  language: string,
): Map<string, FunctionCall[]> {
  const callsBySymbol = new Map<string, FunctionCall[]>();

  // Query patterns for function calls in different languages
  const callPatterns: Record<string, string> = {
    typescript: `
      (call_expression
        function: [(identifier) @callee
                   (member_expression property: (property_identifier) @callee)]
        arguments: (arguments) @args)
    `,
    javascript: `
      (call_expression
        function: [(identifier) @callee
                   (member_expression property: (property_identifier) @callee)]
        arguments: (arguments) @args)
    `,
    python: `
      (call
        function: [(identifier) @callee
                   (attribute attribute: (identifier) @callee)]
        arguments: (argument_list) @args)
    `,
    go: `
      (call_expression
        function: [(identifier) @callee
                   (selector_expression field: (field_identifier) @callee)]
        arguments: (argument_list) @args)
    `,
  };

  const pattern = callPatterns[language];
  if (!pattern) {
    return callsBySymbol;
  }

  try {
    const query = new Query(languageInstance, pattern);
    const matches = query.matches(tree.rootNode);

    // Extract callee names from matches
    const callCaptures: { callee: string; position: Position }[] = [];

    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name === "callee") {
          callCaptures.push({
            callee: capture.node.text,
            position: {
              line: capture.node.startPosition.row + 1,
              column: capture.node.startPosition.column,
              offset: capture.node.startIndex,
            },
          });
        }
      }
    }

    // For now, store all calls without symbol association
    // A more sophisticated approach would track which symbol contains each call
    if (callCaptures.length > 0) {
      callsBySymbol.set(
        "__global__",
        callCaptures.map((c) => ({
          callee: c.callee,
          position: c.position,
        })),
      );
    }
  } catch (error) {
    logger.warn(
      `Failed to extract calls for ${language}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return callsBySymbol;
}

/**
 * Associate calls with their containing symbols
 */
function associateCallsWithSymbols(
  symbols: Symbol[],
  allCalls: FunctionCall[],
): Map<string, FunctionCall[]> {
  const callsBySymbol = new Map<string, FunctionCall[]>();

  // Sort symbols by start offset for efficient lookup
  const sortedSymbols = [...symbols]
    .filter((s) => s.type === "function" || s.type === "method")
    .sort((a, b) => a.start.offset - b.start.offset);

  for (const call of allCalls) {
    // Find the symbol that contains this call
    let containingSymbol: Symbol | null = null;

    for (const symbol of sortedSymbols) {
      if (
        call.position.offset >= symbol.start.offset &&
        call.position.offset <= symbol.end.offset
      ) {
        containingSymbol = symbol;
      } else if (call.position.offset < symbol.start.offset) {
        // Calls are sorted by position, so we can break early
        break;
      }
    }

    const symbolName = containingSymbol?.name ?? "__global__";
    const existing = callsBySymbol.get(symbolName) ?? [];
    existing.push(call);
    callsBySymbol.set(symbolName, existing);
  }

  return callsBySymbol;
}

/**
 * Analyze a file and extract call graph data
 */
export async function analyzeFileForCallGraph(
  filePath: string,
  content: string,
): Promise<FileCallData | null> {
  const contentHash = computeCallGraphHash(content);

  // Check cache
  const cached = callGraphCache.get(filePath);
  if (cached?.contentHash === contentHash) {
    return cached;
  }

  try {
    const parseResult = await parseCode(content, { filePath });

    const { symbols } = extractSymbols(
      parseResult.tree,
      parseResult.languageInstance,
      parseResult.language,
    );

    const callsMap = extractCallsFromTree(
      parseResult.tree,
      parseResult.languageInstance,
      parseResult.language,
    );

    // Get all calls and associate with symbols
    const allCalls = callsMap.get("__global__") ?? [];
    const callsBySymbol = associateCallsWithSymbols(symbols, allCalls);

    const data: FileCallData = {
      contentHash,
      symbols,
      calls: callsBySymbol,
    };

    callGraphCache.set(filePath, data);
    return data;
  } catch (error) {
    logger.debug(
      `Failed to analyze ${filePath} for call graph: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * Build a call graph from multiple files
 *
 * Uses persistent caching with hash-based invalidation for performance.
 */
export async function buildCallGraph(
  files: { path: string; content: string }[],
): Promise<CallGraph> {
  if (files.length === 0) {
    return { nodes: new Map(), files: [], edgeCount: 0 };
  }

  // Compute hashes for all files
  const fileHashes: Record<string, string> = {};
  for (const file of files) {
    fileHashes[file.path] = computeCallGraphHash(file.content);
  }

  // Determine base directory from common path prefix
  const baseDir = findCommonDirectory(files.map((f) => f.path));

  // Try to load from persistent cache
  const cached = loadCallGraphCache(baseDir, fileHashes);
  if (cached) {
    return cached;
  }

  // Build the call graph
  const nodes = new Map<string, CallGraphNode>();
  const nodesByName = new Map<string, string[]>();
  const filePaths: string[] = [];
  let edgeCount = 0;

  // First pass: collect all symbols
  for (const file of files) {
    filePaths.push(file.path);
    const data = await analyzeFileForCallGraph(file.path, file.content);

    if (!data) {
      continue;
    }

    // Create nodes for all functions/methods
    for (const symbol of data.symbols) {
      if (symbol.type === "function" || symbol.type === "method") {
        const qualifiedName = `${file.path}:${symbol.name}`;
        nodes.set(qualifiedName, {
          name: symbol.name,
          qualifiedName,
          filePath: file.path,
          type: symbol.type,
          start: symbol.start,
          end: symbol.end,
          calls: [],
          calledBy: [],
        });
        const matchingNodes = nodesByName.get(symbol.name) ?? [];
        matchingNodes.push(qualifiedName);
        nodesByName.set(symbol.name, matchingNodes);
      }
    }
  }

  // Second pass: build edges
  for (const file of files) {
    const data = callGraphCache.get(file.path);
    if (!data) {
      continue;
    }

    for (const [symbolName, calls] of data.calls) {
      const callerKey = `${file.path}:${symbolName}`;
      const callerNode = nodes.get(callerKey);

      if (!callerNode && symbolName !== "__global__") {
        continue;
      }

      for (const call of calls) {
        // Try to find the callee by name. This remains a conservative
        // syntactic resolution, but avoids scanning every graph node for each
        // call on large repositories.
        for (const nodeKey of nodesByName.get(call.callee) ?? []) {
          const node = nodes.get(nodeKey);
          if (!node) {
            continue;
          }
          if (callerNode) {
            callerNode.calls.push(nodeKey);
          }
          node.calledBy.push(callerKey);
          edgeCount++;
        }
      }
    }
  }

  const graph: CallGraph = {
    nodes,
    files: filePaths,
    edgeCount,
  };

  // Save to persistent cache
  saveCallGraphCache(baseDir, graph, fileHashes);

  return graph;
}

/**
 * Find common directory from a list of file paths
 */
function findCommonDirectory(paths: string[]): string {
  if (paths.length === 0) {
    return ".";
  }

  const firstPathStr = paths[0];
  if (!firstPathStr) {
    return ".";
  }

  if (paths.length === 1) {
    return path.dirname(firstPathStr);
  }

  // Normalize paths and split into segments
  const segments = paths.map((p) => path.normalize(p).split(path.sep));
  const firstPath = segments[0];

  if (!firstPath) {
    return ".";
  }

  // Find common prefix
  let commonLength = 0;

  for (let i = 0; i < firstPath.length; i++) {
    const segment = firstPath[i];
    if (segment && segments.every((s) => s[i] === segment)) {
      commonLength = i + 1;
    } else {
      break;
    }
  }

  // Build common directory path
  const commonSegments = firstPath.slice(0, commonLength);
  const commonDir = commonSegments.join(path.sep);

  // If the common path is a file, return its directory
  if (commonDir && fs.existsSync(commonDir) && fs.statSync(commonDir).isFile()) {
    return path.dirname(commonDir);
  }

  return commonDir || ".";
}

/**
 * Get call graph cache statistics
 */
export function getCallGraphCacheStats(): {
  files: number;
  entries: string[];
} {
  return {
    files: callGraphCache.size,
    entries: Array.from(callGraphCache.keys()),
  };
}
