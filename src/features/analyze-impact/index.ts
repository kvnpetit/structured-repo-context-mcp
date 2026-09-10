import { z } from "zod";

import { dependencyGraphFeature } from "@features/dependency-graph";
import type { Feature, FeatureResult } from "@features/types";
import { createFeatureResultSchema } from "@features/utils";

export const analyzeImpactSchema = z.object({
  directory: z.string().optional().default(".").describe("Project root"),
  changed_files: z.array(z.string()).min(1).max(50).describe("Changed project-relative files"),
  max_files: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .default(200)
    .describe("Maximum graph files"),
});

export type AnalyzeImpactInput = z.input<typeof analyzeImpactSchema>;

interface DependencyGraphData {
  nodes: { path: string }[];
  edges: { from: string; to: string; resolved: boolean }[];
}

interface ImpactOutput {
  changed_files: string[];
  directly_impacted: string[];
  transitively_impacted: string[];
  unknown_changed_files: string[];
  graph_files: number;
}

const analyzeImpactDataSchema = z
  .object({
    changed_files: z.string().array(),
    directly_impacted: z.string().array(),
    transitively_impacted: z.string().array(),
    unknown_changed_files: z.string().array(),
    graph_files: z.number().int().nonnegative(),
  })
  .strict();

export const analyzeImpactOutputSchema = createFeatureResultSchema(analyzeImpactDataSchema);

function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//u, "");
}

export async function execute(rawInput: AnalyzeImpactInput): Promise<FeatureResult> {
  const input = analyzeImpactSchema.parse(rawInput);
  const graphResult = await dependencyGraphFeature.execute({
    directory: input.directory,
    max_files: input.max_files,
    max_edges: 2_000,
    max_type_nodes: 5_000,
    max_type_edges: 10_000,
    include_external: false,
  });
  if (!graphResult.success) {
    return graphResult;
  }
  const graph = graphResult.data as DependencyGraphData;
  const nodes = new Set(graph.nodes.map((node) => normalize(node.path)));
  const changed = input.changed_files.map(normalize);
  const unknown = changed.filter((file) => !nodes.has(file));
  const reverse = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!edge.resolved) {
      continue;
    }
    const dependents = reverse.get(normalize(edge.to)) ?? new Set<string>();
    dependents.add(normalize(edge.from));
    reverse.set(normalize(edge.to), dependents);
  }

  const direct = new Set<string>();
  for (const file of changed) {
    for (const dependent of reverse.get(file) ?? []) {
      direct.add(dependent);
    }
  }
  const transitive = new Set<string>();
  const queue = [...direct];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || transitive.has(current) || changed.includes(current)) {
      continue;
    }
    transitive.add(current);
    for (const dependent of reverse.get(current) ?? []) {
      queue.push(dependent);
    }
  }
  const output: ImpactOutput = {
    changed_files: changed,
    directly_impacted: [...direct].sort(),
    transitively_impacted: [...transitive].sort(),
    unknown_changed_files: unknown,
    graph_files: graph.nodes.length,
  };
  return {
    success: true,
    message: `Impact analysis: ${String(output.directly_impacted.length)} direct, ${String(output.transitively_impacted.length)} transitive dependents`,
    data: output,
  };
}

export const analyzeImpactFeature: Feature<typeof analyzeImpactSchema> = {
  name: "analyze_impact",
  title: "Analyze change impact",
  description:
    "Read-only blast-radius analysis for changed files using the project dependency graph and reverse transitive closure.",
  schema: analyzeImpactSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  outputSchema: analyzeImpactOutputSchema,
  execute,
};
