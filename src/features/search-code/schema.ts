import { z } from "zod";

import { createFeatureResultSchema, instructionSignalsSchema } from "@features/utils";

export const searchCodeSchema = z.object({
  query: z.string().min(1).describe("Natural language search query"),
  directory: z
    .string()
    .optional()
    .default(".")
    .describe("Path to the indexed directory (defaults to current directory)"),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .default(10)
    .describe("Maximum number of results to return"),
  cursor: z
    .string()
    .max(1_024)
    .optional()
    .describe("Opaque cursor returned by a previous search page"),
  min_confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0)
    .describe("Optional local confidence floor; above it the tool may abstain"),
  threshold: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe("Maximum distance threshold for results (lower = more similar)"),
  mode: z
    .enum(["vector", "fts", "hybrid"])
    .optional()
    .default("hybrid")
    .describe(
      "Search mode: 'vector' (semantic only), 'fts' (keyword only), 'hybrid' (combined with RRF fusion)",
    ),
  vectorWeight: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.5)
    .describe("Hybrid RRF weight for semantic vector results (0 = keyword only, 1 = vector only)"),
  includeCallContext: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include caller/callee information for each result (uses cached call graph)"),
  rerank: z
    .enum(["none", "lexical", "code"])
    .optional()
    .default("lexical")
    .describe(
      "Optional deterministic reranking: lexical or code-aware symbol/signature ranking without another model",
    ),
  language: z.string().trim().min(1).optional().describe("Filter results to one detected language"),
  path_prefix: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Filter results to a project-relative path prefix"),
  symbol_type: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Filter results to a symbol kind such as function or class"),
  include_tests: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether test/spec paths are eligible (default: true)"),
  redact_secrets: z
    .boolean()
    .optional()
    .default(true)
    .describe("Redact common inline secrets in returned source (default: true)"),
  max_content_bytes: z
    .number()
    .int()
    .positive()
    .max(100_000)
    .optional()
    .default(20_000)
    .describe("Maximum UTF-8 bytes returned for each source result (default: 20000)"),
  neighbor_window: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .default(0)
    .describe(
      "Optional bounded same-file context window in chunks on each side of a hit (0 disables it)",
    ),
});

export type SearchCodeInput = z.input<typeof searchCodeSchema>;

const searchPartsSchema = z
  .object({
    signature: z.string().optional(),
    documentation: z.string().optional(),
    body: z.string(),
  })
  .strict();

const searchResultSchema = z
  .object({
    filePath: z.string(),
    language: z.string(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    content: z.string(),
    score: z.number(),
    confidence: z.number().min(0).max(1),
    content_truncated: z.boolean().optional(),
    is_neighbor: z.boolean().optional(),
    neighbor_of: z.string().optional(),
    neighbor_distance: z.number().int().positive().optional(),
    parts: searchPartsSchema,
    symbolName: z.string().optional(),
    symbolType: z.string().optional(),
    callContext: z
      .object({ callers: z.string().array(), callees: z.string().array() })
      .strict()
      .optional(),
  })
  .strict();

const searchCodeDataSchema = z
  .object({
    query: z.string(),
    directory: z.string(),
    resultsCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    cursor_offset: z.number().int().nonnegative(),
    next_cursor: z.string().optional(),
    retrieval: z
      .object({
        query_kind: z.enum(["identifier", "concept", "mixed"]),
        reranker: z.enum(["none", "lexical", "code"]),
        candidates_considered: z.number().int().nonnegative(),
        duplicates_removed: z.number().int().nonnegative(),
        min_confidence: z.number().min(0).max(1),
        abstained: z.boolean(),
        abstention_reason: z.string().optional(),
        content_limit_bytes: z.number().int().positive(),
        content_truncated_count: z.number().int().nonnegative(),
        neighbor_window: z.number().int().nonnegative().max(3),
        neighbors_added: z.number().int().nonnegative(),
        neighbor_candidates_considered: z.number().int().nonnegative(),
        neighbors_truncated: z.boolean(),
      })
      .strict(),
    filters: z
      .object({
        language: z.string().optional(),
        path_prefix: z.string().optional(),
        symbol_type: z.string().optional(),
        include_tests: z.boolean(),
      })
      .strict(),
    index: z
      .object({
        schema_version: z.number().int().optional(),
        embedding_provider: z.string().optional(),
        embedding_model: z.string().optional(),
        embedding_dimensions: z.number().int().optional(),
        updated_at: z.string().optional(),
        source_fingerprint: z.string().optional(),
      })
      .strict(),
    source_is_untrusted: z.literal(true),
    secrets_redacted: z.boolean(),
    instruction_signals: instructionSignalsSchema,
    results: searchResultSchema.array(),
  })
  .strict();

export const searchCodeOutputSchema = createFeatureResultSchema(searchCodeDataSchema);
