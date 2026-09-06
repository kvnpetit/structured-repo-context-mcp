import { z } from "zod";

import {
  createFeatureResultSchema,
  instructionSignalsSchema,
} from "@features/utils";

export const assembleTaskContextSchema = z.object({
  directory: z.string().optional().default(".").describe("Project directory"),
  task: z
    .string()
    .trim()
    .min(3)
    .max(2_000)
    .describe("The development task or question to orient around"),
  depth: z
    .enum(["minimal", "standard", "deep"])
    .optional()
    .default("standard")
    .describe(
      "Context breadth: map/search only, normal agent dossier, or deeper evidence",
    ),
  max_tokens: z
    .number()
    .int()
    .positive()
    .max(20_000)
    .optional()
    .default(4_000)
    .describe("Approximate maximum size of the rendered context bundle"),
  search_limit: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .default(8)
    .describe("Maximum semantic search results"),
  include_search: z.boolean().optional().default(true),
  include_project_context: z.boolean().optional(),
  include_memory: z.boolean().optional(),
  include_artifacts: z.boolean().optional(),
  include_git: z.boolean().optional(),
  memory_scope: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/iu)
    .optional()
    .default("project"),
  memory_min_confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.4)
    .describe("Ignore low-confidence memories in the agent dossier"),
});

export type AssembleTaskContextInput = z.input<
  typeof assembleTaskContextSchema
>;

const taskSearchResultSchema = z
  .object({
    filePath: z.string().optional(),
    language: z.string().optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    content: z.string().optional(),
    score: z.number().optional(),
    confidence: z.number().min(0).max(1).optional(),
    symbolName: z.string().optional(),
    symbolType: z.string().optional(),
    is_neighbor: z.boolean().optional(),
    neighbor_of: z.string().optional(),
    neighbor_distance: z.number().int().positive().optional(),
  })
  .strict();

const layerStatusSchema = z
  .object({
    enabled: z.boolean(),
    available: z.boolean(),
    items: z.number().int().nonnegative(),
    allocated_tokens: z.number().int().nonnegative(),
    emitted_tokens: z.number().int().nonnegative(),
    truncated: z.boolean(),
    error: z.string().optional(),
  })
  .strict();

const assembleTaskContextDataSchema = z
  .object({
    directory: z.string(),
    task: z.string(),
    depth: z.enum(["minimal", "standard", "deep"]),
    focus_terms: z.string().array(),
    estimated_tokens: z.number().int().nonnegative(),
    token_budget: z.number().int().positive(),
    truncated: z.boolean(),
    repository_map: z.string(),
    search: z
      .object({
        available: z.boolean(),
        results: taskSearchResultSchema.array(),
        error: z.string().optional(),
      })
      .strict(),
    layers: z
      .object({
        project: layerStatusSchema,
        memory: layerStatusSchema,
        artifacts: layerStatusSchema,
        git: layerStatusSchema,
        repository_map: layerStatusSchema,
        search: layerStatusSchema,
      })
      .strict(),
    next_actions: z.string().array(),
    context: z.string(),
    warnings: z.string().array(),
    source_is_untrusted: z.literal(true),
    instruction_signals: instructionSignalsSchema,
  })
  .strict();

export const assembleTaskContextOutputSchema = createFeatureResultSchema(
  assembleTaskContextDataSchema,
);
