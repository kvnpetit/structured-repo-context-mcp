/**
 * Call graph extraction and storage
 *
 * Extracts function call relationships from code using tree-sitter
 * to build a graph showing which functions call which.
 */

import { Query } from "web-tree-sitter";
import type { Position, Symbol } from "@core/ast/types";
import { parseCode, type ParseResult } from "@core/parser";
import { extractSymbols } from "@core/symbols";
import { registerCache } from "@core/utils";
import { logger } from "@utils";

/**
 * A function call found in code
 */
export interface FunctionCall {
  /** Name of the called function */
  callee: string;
  /** Position of the call */
  position: Position;
  /** Arguments passed (if extractable) */
  arguments?: string[];
}

/**
 * A node in the call graph
 */
export interface CallGraphNode {
  /** Function/method name */
  name: string;
  /** Full qualified name (file:function) */
  qualifiedName: string;
  /** File path */
  filePath: string;
  /** Function type */
  type: string;
  /** Start position */
  start: Position;
  /** End position */
  end: Position;
  /** Functions this node calls */
  calls: string[];
  /** Functions that call this node */
  calledBy: string[];
}

/**
 * The complete call graph for a codebase
 */
export interface CallGraph {
  /** All nodes in the graph */
  nodes: Map<string, CallGraphNode>;
  /** File paths included in the graph */
  files: string[];
  /** Total number of call edges */
  edgeCount: number;
}

/**
 * Call graph cache per file
 */
interface FileCallData {
  symbols: Symbol[];
  calls: Map<string, FunctionCall[]>; // symbol name -> calls made
}

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
    const callCaptures: Array<{ callee: string; position: Position }> = [];

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
    logger.debug(
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
  // Check cache
  const cached = callGraphCache.get(filePath);
  if (cached) {
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
 */
export async function buildCallGraph(
  files: Array<{ path: string; content: string }>,
): Promise<CallGraph> {
  const nodes = new Map<string, CallGraphNode>();
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
        // Try to find the callee in our nodes
        // This is a simplified approach - in reality we'd need to resolve imports
        for (const [nodeKey, node] of nodes) {
          if (node.name === call.callee) {
            // Add edge
            if (callerNode) {
              callerNode.calls.push(nodeKey);
            }
            node.calledBy.push(callerKey);
            edgeCount++;
          }
        }
      }
    }
  }

  return {
    nodes,
    files: filePaths,
    edgeCount,
  };
}

/**
 * Get callers and callees for a specific function
 */
export function getCallContext(
  graph: CallGraph,
  filePath: string,
  functionName: string,
): {
  callers: CallGraphNode[];
  callees: CallGraphNode[];
} | null {
  const qualifiedName = `${filePath}:${functionName}`;
  const node = graph.nodes.get(qualifiedName);

  if (!node) {
    return null;
  }

  const callers: CallGraphNode[] = [];
  const callees: CallGraphNode[] = [];

  for (const callerKey of node.calledBy) {
    const caller = graph.nodes.get(callerKey);
    if (caller) {
      callers.push(caller);
    }
  }

  for (const calleeKey of node.calls) {
    const callee = graph.nodes.get(calleeKey);
    if (callee) {
      callees.push(callee);
    }
  }

  return { callers, callees };
}

/**
 * Format call context as a string for enrichment
 */
export function formatCallContext(
  callers: CallGraphNode[],
  callees: CallGraphNode[],
  maxItems: number = 5,
): string {
  const lines: string[] = [];

  if (callers.length > 0) {
    const callerNames = callers
      .slice(0, maxItems)
      .map((c) => c.name)
      .join(", ");
    lines.push(`Called by: ${callerNames}`);
  }

  if (callees.length > 0) {
    const calleeNames = callees
      .slice(0, maxItems)
      .map((c) => c.name)
      .join(", ");
    lines.push(`Calls: ${calleeNames}`);
  }

  return lines.join("\n");
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
