import { z } from "zod";

import { createFeatureResultSchema } from "@features/utils";

const MAX_QUERY_LENGTH = 4_000;
const MAX_PATHS = 100;
const MAX_RESULTS = 500;
const MAX_TIMEOUT_MS = 60_000;

export const BACKENDS = ["ast-grep", "semgrep", "codeql"] as const;
export type StaticBackend = (typeof BACKENDS)[number];

const commonInput = {
  directory: z.string().optional().default(".").describe("Project directory"),
  paths: z
    .string()
    .array()
    .max(MAX_PATHS)
    .optional()
    .default([])
    .describe("Optional safe project-relative paths"),
  max_results: z
    .number()
    .int()
    .positive()
    .max(MAX_RESULTS)
    .optional()
    .default(100),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .default(15_000),
  redact_secrets: z.boolean().optional().default(true),
};

const patternInputSchema = z.object({
  ...commonInput,
  backend: z.enum(["ast-grep", "semgrep"]),
  pattern: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
  language: z.string().trim().min(1).max(50),
});

const ruleFileInputSchema = z.object({
  ...commonInput,
  backend: z.enum(["ast-grep", "semgrep"]),
  rule_file: z
    .string()
    .trim()
    .min(1)
    .max(1_000)
    .describe("Existing project-relative ast-grep or Semgrep rule file"),
});

const codeqlInputSchema = z.object({
  ...commonInput,
  backend: z.literal("codeql"),
  database: z.string().trim().min(1).max(1_000),
  query_file: z.string().trim().min(1).max(1_000),
});

export const staticAnalysisSchema = z.union([
  patternInputSchema,
  ruleFileInputSchema,
  codeqlInputSchema,
]);

export type StaticAnalysisInput = z.input<typeof staticAnalysisSchema>;

export function ruleFileOf(input: StaticAnalysisInput): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(input, "rule_file")) {
    return undefined;
  }
  const value = (input as { rule_file?: unknown }).rule_file;
  return typeof value === "string" ? value : undefined;
}

const findingSchema = z
  .object({
    backend: z.enum(BACKENDS),
    rule_id: z.string().optional(),
    message: z.string().optional(),
    file_path: z.string().optional(),
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
    start_column: z.number().int().nonnegative().optional(),
    end_column: z.number().int().nonnegative().optional(),
    severity: z.string().optional(),
    snippet: z.string().optional(),
  })
  .strict();

const staticAnalysisDataSchema = z
  .object({
    directory: z.string(),
    backend: z.enum(BACKENDS),
    enabled: z.boolean(),
    available: z.boolean(),
    executable: z.string().optional(),
    query_kind: z.enum(["pattern", "rules-file", "codeql-query"]),
    rule_file: z.string().optional(),
    findings: findingSchema.array(),
    findings_count: z.number().int().nonnegative(),
    truncated: z.boolean(),
    timed_out: z.boolean(),
    output_truncated: z.boolean(),
    source_is_untrusted: z.literal(true),
    secrets_redacted: z.boolean(),
    stderr: z.string().optional(),
    errors: z.string().array(),
  })
  .strict();

export const staticAnalysisOutputSchema = createFeatureResultSchema(
  staticAnalysisDataSchema,
);
