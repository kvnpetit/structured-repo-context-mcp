import { z } from "zod";

import { createFeatureResultSchema } from "@features/utils";

export const nodeKinds = ["module", "symbol", "route", "event", "dependency"] as const;
export const edgeKinds = [
  "contains",
  "imports",
  "references",
  "calls",
  "inherits",
  "implements",
  "tests",
  "routes",
  "emits",
  "injects",
] as const;

export const symbolGraphSchema = z.object({
  directory: z.string().optional().default(".").describe("Project directory"),
  focus: z
    .array(z.string().trim().min(1))
    .max(20)
    .optional()
    .default([])
    .describe("Optional symbol, path, or node identifiers to prioritize"),
  edge_kinds: z
    .array(z.enum(edgeKinds))
    .max(edgeKinds.length)
    .optional()
    .default([...edgeKinds])
    .describe("Relationship kinds to include"),
  trace_from: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional node, symbol, or path at the start of a trace"),
  trace_to: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional node, symbol, or path at the end of a trace"),
  trace_direction: z
    .enum(["forward", "reverse", "both"])
    .optional()
    .default("forward")
    .describe("Direction used by trace_path"),
  max_path_length: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .default(8)
    .describe("Maximum edges in a returned trace"),
  max_files: z
    .number()
    .int()
    .positive()
    .max(2_000)
    .optional()
    .default(500)
    .describe("Maximum source files to inspect"),
  max_nodes: z
    .number()
    .int()
    .positive()
    .max(5_000)
    .optional()
    .default(1_000)
    .describe("Maximum graph nodes returned"),
  max_edges: z
    .number()
    .int()
    .positive()
    .max(20_000)
    .optional()
    .default(5_000)
    .describe("Maximum graph edges returned"),
  include_tests: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include test symbols and test discovery edges"),
  include_signals: z
    .boolean()
    .optional()
    .default(true)
    .describe("Detect static route, event, and dependency-injection signals"),
  redact_secrets: z
    .boolean()
    .optional()
    .default(true)
    .describe("Redact common secrets in evidence snippets"),
});

export type SymbolGraphInput = z.input<typeof symbolGraphSchema>;
export type SymbolGraphOptions = z.infer<typeof symbolGraphSchema>;

export type NodeKind = (typeof nodeKinds)[number];
export type EdgeKind = (typeof edgeKinds)[number];

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  path: string;
  language?: string;
  symbol_type?: string;
  line?: number;
  end_line?: number;
  signature?: string;
  is_test?: boolean;
  evidence?: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  confidence: number;
  path: string;
  line?: number;
  evidence?: string;
}

export interface UnresolvedRelation {
  kind: EdgeKind | "import";
  from: string;
  target: string;
  path: string;
  line?: number;
}

export interface TracePath {
  from: string;
  to: string;
  found: boolean;
  nodes: string[];
  edges: string[];
  truncated: boolean;
}

export interface BlastRadius {
  focus: string[];
  direct: string[];
  transitive: string[];
  truncated: boolean;
  confidence: number;
}

export interface TestDiscovery {
  target: string;
  tests: string[];
  files: string[];
  truncated: boolean;
}

export interface SymbolGraphOutput {
  directory: string;
  files_analyzed: number;
  files_truncated: boolean;
  total_nodes: number;
  total_edges: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  source_revision: string;
  coverage: "approximate";
  confidence: number;
  trace_paths: TracePath[];
  blast_radius: BlastRadius;
  test_discovery: TestDiscovery[];
  signals: { routes: number; events: number; dependencies: number };
  unresolved: UnresolvedRelation[];
  source_is_untrusted: true;
  secrets_redacted: boolean;
  errors: string[];
  limitations: string[];
}

const graphPositionSchema = z
  .object({
    id: z.string(),
    kind: z.enum(nodeKinds),
    name: z.string(),
    path: z.string(),
    language: z.string().optional(),
    symbol_type: z.string().optional(),
    line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
    signature: z.string().optional(),
    is_test: z.boolean().optional(),
    evidence: z.string().optional(),
  })
  .strict();
const graphEdgeSchema = z
  .object({
    id: z.string(),
    from: z.string(),
    to: z.string(),
    kind: z.enum(edgeKinds),
    confidence: z.number().min(0).max(1),
    path: z.string(),
    line: z.number().int().positive().optional(),
    evidence: z.string().optional(),
  })
  .strict();
const symbolGraphDataSchema = z
  .object({
    directory: z.string(),
    files_analyzed: z.number().int().nonnegative(),
    files_truncated: z.boolean(),
    total_nodes: z.number().int().nonnegative(),
    total_edges: z.number().int().nonnegative(),
    nodes: graphPositionSchema.array(),
    edges: graphEdgeSchema.array(),
    truncated: z.boolean(),
    source_revision: z.string(),
    coverage: z.literal("approximate"),
    confidence: z.number().min(0).max(1),
    trace_paths: z
      .object({
        from: z.string(),
        to: z.string(),
        found: z.boolean(),
        nodes: z.string().array(),
        edges: z.string().array(),
        truncated: z.boolean(),
      })
      .strict()
      .array(),
    blast_radius: z
      .object({
        focus: z.string().array(),
        direct: z.string().array(),
        transitive: z.string().array(),
        truncated: z.boolean(),
        confidence: z.number().min(0).max(1),
      })
      .strict(),
    test_discovery: z
      .object({
        target: z.string(),
        tests: z.string().array(),
        files: z.string().array(),
        truncated: z.boolean(),
      })
      .strict()
      .array(),
    signals: z
      .object({
        routes: z.number().int().nonnegative(),
        events: z.number().int().nonnegative(),
        dependencies: z.number().int().nonnegative(),
      })
      .strict(),
    unresolved: z
      .object({
        kind: z.union([z.enum(edgeKinds), z.literal("import")]),
        from: z.string(),
        target: z.string(),
        path: z.string(),
        line: z.number().int().positive().optional(),
      })
      .strict()
      .array(),
    source_is_untrusted: z.literal(true),
    secrets_redacted: z.boolean(),
    errors: z.string().array(),
    limitations: z.string().array(),
  })
  .strict();

export const symbolGraphOutputSchema = createFeatureResultSchema(symbolGraphDataSchema);
