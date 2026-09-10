import { z } from "zod";

import { createFeatureResultSchema } from "@features/utils";

const DEFAULT_MAX_FILES = 1_000;
const DEFAULT_MAX_MANIFESTS = 100;

export const projectContextSchema = z.object({
  directory: z.string().optional().default(".").describe("Project directory"),
  max_files: z
    .number()
    .int()
    .positive()
    .max(5_000)
    .optional()
    .default(DEFAULT_MAX_FILES)
    .describe("Maximum source files to inspect"),
  max_manifests: z
    .number()
    .int()
    .positive()
    .max(DEFAULT_MAX_MANIFESTS)
    .optional()
    .default(DEFAULT_MAX_MANIFESTS)
    .describe("Maximum project manifests to inspect"),
  include_scripts: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include package scripts, without executing them"),
  redact_secrets: z
    .boolean()
    .optional()
    .default(true)
    .describe("Redact common inline secrets in returned commands"),
});

export type ProjectContextInput = z.input<typeof projectContextSchema>;

const projectContextDataSchema = z
  .object({
    directory: z.string(),
    project_name: z.string().optional(),
    project_kind: z.enum(["application", "library", "workspace", "unknown"]),
    languages: z.object({ language: z.string(), files: z.number(), bytes: z.number() }).array(),
    frameworks: z
      .object({
        name: z.string(),
        category: z.string(),
        evidence: z.string().array(),
      })
      .array(),
    manifests: z
      .object({
        path: z.string(),
        kind: z.string(),
        size_bytes: z.number(),
        project_name: z.string().optional(),
        package_manager: z.string().optional(),
        scripts: z.record(z.string(), z.string()).optional(),
        workspaces: z.string().array().optional(),
      })
      .array(),
    scripts: z.object({ name: z.string(), command: z.string(), source: z.string() }).array(),
    workspaces: z.string().array(),
    entrypoints: z.string().array(),
    test_roots: z.string().array(),
    test_files: z.string().array(),
    configuration_files: z.string().array(),
    documentation_files: z.string().array(),
    path_aliases: z.record(z.string(), z.string()),
    files_analyzed: z.number(),
    manifests_analyzed: z.number(),
    truncated: z.boolean(),
    profile_fingerprint: z.string(),
    source_is_untrusted: z.literal(true),
    secrets_redacted: z.boolean(),
    errors: z.string().array(),
  })
  .strict();

export const projectContextOutputSchema = createFeatureResultSchema(projectContextDataSchema);
