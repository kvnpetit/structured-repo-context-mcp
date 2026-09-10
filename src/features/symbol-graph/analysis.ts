import { findMatchingNodeIds, relationshipEdges, sortedUnique, walkPath } from "./helpers";
import type {
  BlastRadius,
  GraphEdge,
  GraphNode,
  SymbolGraphOptions,
  TestDiscovery,
  TracePath,
} from "./schema";

export interface GraphAnalysis {
  filteredEdges: GraphEdge[];
  allNodes: GraphNode[];
  selectedNodes: GraphNode[];
  selectedEdges: GraphEdge[];
  graphTruncated: boolean;
  tracePaths: TracePath[];
  blastRadius: BlastRadius;
  testDiscovery: TestDiscovery[];
}

export function analyzeGraph(options: {
  nodes: ReadonlyMap<string, GraphNode>;
  edges: GraphEdge[];
  input: SymbolGraphOptions;
  filesTruncated: boolean;
  rawNodesSkipped: number;
  rawEdgesSkipped: number;
}): GraphAnalysis {
  const { nodes, edges, input, filesTruncated, rawNodesSkipped, rawEdgesSkipped } = options;
  const filteredEdges = relationshipEdges(edges, input.edge_kinds).sort(
    (left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      left.kind.localeCompare(right.kind),
  );
  const allNodes = [...nodes.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.id.localeCompare(right.id),
  );
  const focusNodes = new Set(input.focus.flatMap((query) => findMatchingNodeIds(allNodes, query)));
  const selectedNodes = allNodes
    .slice()
    .sort(
      (left, right) =>
        Number(focusNodes.has(right.id)) - Number(focusNodes.has(left.id)) ||
        left.path.localeCompare(right.path) ||
        (left.line ?? 0) - (right.line ?? 0) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, input.max_nodes)
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        (left.line ?? 0) - (right.line ?? 0) ||
        left.id.localeCompare(right.id),
    );
  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  const selectedEdges = filteredEdges
    .filter((edge) => selectedIds.has(edge.from) && selectedIds.has(edge.to))
    .slice(0, input.max_edges);
  const graphTruncated =
    filesTruncated ||
    rawNodesSkipped > 0 ||
    rawEdgesSkipped > 0 ||
    allNodes.length > selectedNodes.length ||
    filteredEdges.length > selectedEdges.length;

  const adjacency = new Map<string, GraphEdge[]>();
  const reverse = new Map<string, GraphEdge[]>();
  for (const edge of filteredEdges) {
    const outgoing = adjacency.get(edge.from) ?? [];
    outgoing.push(edge);
    adjacency.set(edge.from, outgoing);
    const incoming = reverse.get(edge.to) ?? [];
    incoming.push(edge);
    reverse.set(edge.to, incoming);
  }

  const tracePaths: TracePath[] = [];
  if (input.trace_from !== undefined && input.trace_to !== undefined) {
    const fromQuery = input.trace_from;
    const toQuery = input.trace_to;
    const fromIds = findMatchingNodeIds(allNodes, fromQuery);
    const toIds = new Set(findMatchingNodeIds(allNodes, toQuery));
    let result: {
      nodes: string[];
      edges: string[];
      found: boolean;
      truncated: boolean;
    } = {
      nodes: [],
      edges: [],
      found: false,
      truncated: false,
    };
    for (const from of fromIds) {
      for (const to of toIds) {
        const candidate = walkPath(
          from,
          to,
          adjacency,
          reverse,
          input.trace_direction,
          input.max_path_length,
        );
        if (candidate.found) {
          result = candidate;
          break;
        }
        result.truncated ||= candidate.truncated;
      }
      if (result.found) {
        break;
      }
    }
    tracePaths.push({
      from: fromIds[0] ?? fromQuery,
      to: [...toIds][0] ?? toQuery,
      ...result,
    });
  }

  const focusIds = [...focusNodes].slice(0, 20);
  const direct = new Set<string>();
  const transitive = new Set<string>();
  const queue: { id: string; depth: number }[] = focusIds.map((id) => ({
    id,
    depth: 0,
  }));
  const visited = new Set(focusIds);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    for (const edge of reverse.get(current.id) ?? []) {
      if (edge.kind === "contains") {
        continue;
      }
      if (visited.has(edge.from)) {
        continue;
      }
      visited.add(edge.from);
      if (current.depth === 0) {
        direct.add(edge.from);
      } else {
        transitive.add(edge.from);
      }
      if (current.depth < input.max_path_length) {
        queue.push({ id: edge.from, depth: current.depth + 1 });
      }
    }
  }
  const blastRadius: BlastRadius = {
    focus: focusIds,
    direct: sortedUnique(direct),
    transitive: sortedUnique(transitive),
    truncated: graphTruncated || queue.length > 0,
    confidence: 0.62,
  };

  const testDiscovery: TestDiscovery[] = [];
  for (const target of focusIds) {
    const tests = sortedUnique(
      (reverse.get(target) ?? []).filter((edge) => edge.kind === "tests").map((edge) => edge.from),
    );
    testDiscovery.push({
      target,
      tests: tests.slice(0, 100),
      files: sortedUnique(
        tests
          .map((id) => nodes.get(id)?.path)
          .filter((value): value is string => value !== undefined),
      ).slice(0, 100),
      truncated: tests.length > 100,
    });
  }

  return {
    filteredEdges,
    allNodes,
    selectedNodes,
    selectedEdges,
    graphTruncated,
    tracePaths,
    blastRadius,
    testDiscovery,
  };
}
