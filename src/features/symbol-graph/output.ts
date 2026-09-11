import type { GraphAnalysis } from "./analysis";
import type { SymbolGraphOutput, UnresolvedRelation } from "./schema";

export function createGraphOutput(options: {
  root: string;
  filesAnalyzed: number;
  filesTruncated: boolean;
  sourceRevision: string;
  analysis: GraphAnalysis;
  signalCounts: { routes: number; events: number; dependencies: number };
  unresolved: UnresolvedRelation[];
  secretsRedacted: boolean;
  errors: string[];
}): SymbolGraphOutput {
  const { analysis } = options;
  return {
    directory: options.root,
    files_analyzed: options.filesAnalyzed,
    files_truncated: options.filesTruncated,
    total_nodes: analysis.allNodes.length,
    total_edges: analysis.filteredEdges.length,
    nodes: analysis.selectedNodes,
    edges: analysis.selectedEdges,
    truncated: analysis.graphTruncated,
    source_revision: options.sourceRevision,
    coverage: "approximate",
    confidence: 0.72,
    trace_paths: analysis.tracePaths,
    blast_radius: analysis.blastRadius,
    test_discovery: analysis.testDiscovery,
    signals: options.signalCounts,
    unresolved: options.unresolved.slice(0, 500),
    source_is_untrusted: true,
    secrets_redacted: options.secretsRedacted,
    errors: options.errors,
    limitations: [
      "Relations are syntax/name based unless a local LSP is used separately; they do not prove compiler-level identity.",
      "Dynamic dispatch, reflection, generated code, macros, runtime dependency injection, and external consumers can be missed.",
      "Routes, events, and dependency-injection nodes are static signals with evidence, not runtime traces.",
      ...(options.filesTruncated
        ? ["The file budget was reached; increase max_files for broader coverage."]
        : []),
    ],
  };
}
