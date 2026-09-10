import { z } from "zod";

import type { TypeHierarchyRelation } from "@core/symbols";
import { createFeatureResultSchema } from "@features/utils";

export const dependencyGraphSchema = z.object({
  directory: z.string().optional().default(".").describe("Project directory"),
  max_files: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .default(200)
    .describe("Maximum files to analyze"),
  max_edges: z
    .number()
    .int()
    .positive()
    .max(20_000)
    .optional()
    .default(2_000)
    .describe("Maximum import edges to return"),
  max_type_nodes: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .default(5_000)
    .describe("Maximum type-hierarchy nodes to return"),
  max_type_edges: z
    .number()
    .int()
    .positive()
    .max(20_000)
    .optional()
    .default(10_000)
    .describe("Maximum type-hierarchy edges to return"),
  include_external: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include unresolved external imports in the graph"),
});

export type DependencyGraphInput = z.input<typeof dependencyGraphSchema>;

export interface GraphNode {
  path: string;
  language: string;
  imports: number;
  exports: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  source: string;
  names: string[];
  resolved: boolean;
}

export interface TypeNode {
  id: string;
  name: string;
  kind: TypeHierarchyRelation["kind"];
  path: string;
  line: number;
}

export interface TypeEdge {
  from: string;
  to: string;
  parent: string;
  resolved: boolean;
}

export interface DependencyGraphOutput {
  directory: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  total_edges: number;
  truncated: boolean;
  files_truncated: boolean;
  cycles: string[][];
  hotspots: {
    path: string;
    inbound: number;
    outbound: number;
    score: number;
  }[];
  unresolvedImports: number;
  filesAnalyzed: number;
  errors: string[];
  typeHierarchy: {
    nodes: TypeNode[];
    edges: TypeEdge[];
    unresolved: string[];
    truncated: boolean;
  };
}

const dependencyGraphDataSchema = z
  .object({
    directory: z.string(),
    nodes: z
      .object({
        path: z.string(),
        language: z.string(),
        imports: z.number().int().nonnegative(),
        exports: z.number().int().nonnegative(),
      })
      .strict()
      .array(),
    edges: z
      .object({
        from: z.string(),
        to: z.string(),
        source: z.string(),
        names: z.string().array(),
        resolved: z.boolean(),
      })
      .strict()
      .array(),
    total_edges: z.number().int().nonnegative(),
    truncated: z.boolean(),
    files_truncated: z.boolean(),
    cycles: z.string().array().array(),
    hotspots: z
      .object({
        path: z.string(),
        inbound: z.number().int().nonnegative(),
        outbound: z.number().int().nonnegative(),
        score: z.number().nonnegative(),
      })
      .strict()
      .array(),
    unresolvedImports: z.number().int().nonnegative(),
    filesAnalyzed: z.number().int().nonnegative(),
    errors: z.string().array(),
    typeHierarchy: z
      .object({
        nodes: z
          .object({
            id: z.string(),
            name: z.string(),
            kind: z.enum(["class", "interface", "type", "enum"]),
            path: z.string(),
            line: z.number().int().positive(),
          })
          .strict()
          .array(),
        edges: z
          .object({
            from: z.string(),
            to: z.string(),
            parent: z.string(),
            resolved: z.boolean(),
          })
          .strict()
          .array(),
        unresolved: z.string().array(),
        truncated: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const dependencyGraphOutputSchema = createFeatureResultSchema(dependencyGraphDataSchema);
