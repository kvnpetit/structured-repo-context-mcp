import { z } from "zod";

import { createFeatureResultSchema, instructionSignalsSchema } from "@features/utils";

export const navigationOperations = [
  "definition",
  "references",
  "implementation",
  "hover",
  "type_hierarchy",
  "diagnostics",
] as const;

export const backendValues = ["auto", "lsp", "scip", "treesitter"] as const;

export const semanticNavigationSchema = z.object({
  directory: z.string().optional().default(".").describe("Project directory"),
  file_path: z.string().describe("Source file path relative to directory"),
  line: z.number().int().positive().describe("1-based source line"),
  column: z.number().int().min(0).describe("0-based character column"),
  operation: z.enum(navigationOperations).describe("Semantic navigation operation to perform"),
  backend: z
    .enum(backendValues)
    .optional()
    .default("auto")
    .describe("Use a local language server, Tree-sitter fallback, or auto"),
  max_results: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .default(50)
    .describe("Maximum locations returned"),
  max_files: z
    .number()
    .int()
    .positive()
    .max(2_000)
    .optional()
    .default(500)
    .describe("Maximum files used by the Tree-sitter fallback"),
  include_source: z.boolean().optional().default(true).describe("Include bounded source snippets"),
  max_source_bytes: z
    .number()
    .int()
    .positive()
    .max(100_000)
    .optional()
    .default(8_000)
    .describe("Maximum source bytes per location or hover result"),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(15_000)
    .optional()
    .default(5_000)
    .describe("Local LSP request timeout"),
  redact_secrets: z
    .boolean()
    .optional()
    .default(true)
    .describe("Redact common secrets in returned source and hover text"),
});

export type SemanticNavigationInput = z.input<typeof semanticNavigationSchema>;
export type SemanticNavigationOptions = z.infer<typeof semanticNavigationSchema>;

const navigationPositionSchema = z
  .object({ line: z.number(), column: z.number(), offset: z.number() })
  .strict();

const semanticNavigationDataSchema = z
  .object({
    operation: z.enum(navigationOperations),
    requested_backend: z.enum(backendValues),
    backend_used: z.enum(["lsp", "scip", "treesitter"]),
    lsp_server: z.object({ id: z.string(), command: z.string() }).strict().optional(),
    file_path: z.string(),
    language: z.string(),
    source_revision: z.string().optional(),
    position: z.object({ line: z.number(), column: z.number() }).strict(),
    symbol: z
      .object({
        name: z.string(),
        type: z.string(),
        signature: z.string().optional(),
      })
      .strict()
      .optional(),
    locations: z
      .object({
        file_path: z.string(),
        start: navigationPositionSchema,
        end: navigationPositionSchema,
        snippet: z.string().optional(),
      })
      .strict()
      .array(),
    hover: z
      .object({
        contents: z.string(),
        range: z
          .object({
            start: navigationPositionSchema,
            end: navigationPositionSchema,
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    diagnostics: z
      .object({
        message: z.string(),
        start: navigationPositionSchema,
        end: navigationPositionSchema,
        severity: z.string().optional(),
        code: z.union([z.string(), z.number()]).optional(),
        source: z.string().optional(),
      })
      .strict()
      .array()
      .optional(),
    coverage: z.enum(["precise", "approximate", "unavailable"]),
    confidence: z.number().min(0).max(1),
    truncated: z.boolean(),
    external_locations_ignored: z.number().int().nonnegative(),
    source_is_untrusted: z.literal(true),
    secrets_redacted: z.boolean(),
    instruction_signals: instructionSignalsSchema,
    warnings: z.string().array(),
  })
  .strict();

export const semanticNavigationOutputSchema = createFeatureResultSchema(
  semanticNavigationDataSchema,
);
