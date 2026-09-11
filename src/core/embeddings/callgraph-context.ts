import type { CallGraph, CallGraphNode } from "@core/embeddings/callgraph-types";

export function getCallContext(
  graph: CallGraph,
  filePath: string,
  functionName: string,
): { callers: CallGraphNode[]; callees: CallGraphNode[] } | null {
  const node = graph.nodes.get(`${filePath}:${functionName}`);
  if (!node) {
    return null;
  }

  const callers = node.calledBy
    .map((key) => graph.nodes.get(key))
    .filter((value): value is CallGraphNode => value !== undefined);
  const callees = node.calls
    .map((key) => graph.nodes.get(key))
    .filter((value): value is CallGraphNode => value !== undefined);
  return { callers, callees };
}

export function formatCallContext(
  callers: CallGraphNode[],
  callees: CallGraphNode[],
  maxItems = 5,
): string {
  const lines: string[] = [];
  if (callers.length > 0) {
    lines.push(
      `Called by: ${callers
        .slice(0, maxItems)
        .map(({ name }) => name)
        .join(", ")}`,
    );
  }
  if (callees.length > 0) {
    lines.push(
      `Calls: ${callees
        .slice(0, maxItems)
        .map(({ name }) => name)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}
