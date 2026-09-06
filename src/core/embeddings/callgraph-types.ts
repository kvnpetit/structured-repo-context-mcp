import type { Position, Symbol } from "@core/ast/types";

/** A function call found in code. */
export interface FunctionCall {
  callee: string;
  position: Position;
  arguments?: string[];
}

/** A function or method represented in the call graph. */
export interface CallGraphNode {
  name: string;
  qualifiedName: string;
  filePath: string;
  type: string;
  start: Position;
  end: Position;
  calls: string[];
  calledBy: string[];
}

/** The complete call graph for a codebase. */
export interface CallGraph {
  nodes: Map<string, CallGraphNode>;
  files: string[];
  edgeCount: number;
}

export interface FileCallData {
  contentHash: string;
  symbols: Symbol[];
  calls: Map<string, FunctionCall[]>;
}

export interface SerializedCallGraph {
  nodes: Record<string, CallGraphNode>;
  files: string[];
  edgeCount: number;
  fileHashes: Record<string, string>;
  timestamp: number;
}
