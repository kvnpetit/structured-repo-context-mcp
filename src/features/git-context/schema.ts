import { z } from "zod";

import { createFeatureResultSchema } from "@features/utils";

export const MAX_FILES = 100;
const MAX_DIFF_BYTES = 500_000;
const MAX_HISTORY = 100;
const MAX_BLAME_LINES = 1_000;
const MAX_HOTSPOTS = 100;
const MAX_REVISION = 200;

const localRevisionSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_REVISION)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/@~^:-]*$/u,
    "Revision must be a local Git ref, commit, or bounded ancestry expression",
  )
  .refine(
    (value) => !value.includes("..") && !value.includes("@{"),
    "Revision ranges and reflog expressions are not accepted",
  )
  .describe("Local Git revision; ranges, reflogs, and remote fetches are rejected");

export const gitContextSchema = z
  .object({
    directory: z.string().optional().default(".").describe("Local Git repository root"),
    files: z
      .string()
      .array()
      .max(MAX_FILES)
      .optional()
      .default([])
      .describe("Optional project-relative paths; no remote refs are accepted"),
    include_status: z.boolean().optional().default(true),
    include_diff: z.boolean().optional().default(true),
    include_history: z.boolean().optional().default(false),
    include_blame: z.boolean().optional().default(false),
    include_codeowners: z.boolean().optional().default(true),
    include_changed_symbols: z.boolean().optional().default(true),
    max_diff_bytes: z.number().int().positive().max(MAX_DIFF_BYTES).optional().default(50_000),
    max_history: z.number().int().positive().max(MAX_HISTORY).optional().default(20),
    include_hotspots: z
      .boolean()
      .optional()
      .default(false)
      .describe("Aggregate historical file churn from local commits"),
    max_hotspots: z.number().int().positive().max(MAX_HOTSPOTS).optional().default(25),
    compare_from: localRevisionSchema.optional(),
    compare_to: localRevisionSchema.optional(),
    max_compare_files: z.number().int().positive().max(MAX_FILES).optional().default(MAX_FILES),
    max_blame_lines: z.number().int().positive().max(MAX_BLAME_LINES).optional().default(200),
    redact_secrets: z.boolean().optional().default(true),
  })
  .superRefine((value, context) => {
    if ((value.compare_from === undefined) !== (value.compare_to === undefined)) {
      context.addIssue({
        code: "custom",
        path: [value.compare_from === undefined ? "compare_from" : "compare_to"],
        message: "compare_from and compare_to must be provided together",
      });
    }
  });

export type GitContextInput = z.input<typeof gitContextSchema>;

const positionSchema = z
  .object({
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .strict();

const gitContextDataSchema = z
  .object({
    directory: z.string(),
    repository_root: z.string(),
    git_available: z.literal(true),
    head: z.string().optional(),
    branch: z.string().optional(),
    clean: z.boolean().optional(),
    files: z
      .object({
        path: z.string(),
        index: z.string(),
        worktree: z.string(),
        status: z.enum(["added", "modified", "deleted", "renamed", "unknown"]),
        staged: z.boolean(),
        untracked: z.boolean(),
      })
      .strict()
      .array(),
    diff: z
      .object({
        text: z.string(),
        bytes: z.number().int().nonnegative(),
        truncated: z.boolean(),
      })
      .strict(),
    history: z
      .object({
        commit: z.string(),
        author: z.string(),
        date: z.string(),
        subject: z.string(),
      })
      .strict()
      .array(),
    hotspots: z
      .object({
        commits_analyzed: z.number().int().nonnegative(),
        files: z
          .object({
            path: z.string(),
            commits: z.number().int().positive(),
            additions: z.number().int().nonnegative(),
            deletions: z.number().int().nonnegative(),
            binary_changes: z.number().int().nonnegative(),
            churn: z.number().int().nonnegative(),
            last_commit: z.string(),
            last_date: z.string(),
          })
          .strict()
          .array(),
        truncated: z.boolean(),
      })
      .strict()
      .optional(),
    revision_compare: z
      .object({
        from: z.string(),
        to: z.string(),
        from_commit: z.string(),
        to_commit: z.string(),
        files_changed: z.number().int().nonnegative(),
        files: z
          .object({
            path: z.string(),
            status: z.enum(["added", "modified", "deleted", "renamed", "unknown"]),
            old_path: z.string().optional(),
          })
          .strict()
          .array(),
        truncated: z.boolean(),
      })
      .strict()
      .optional(),
    blame: z.record(
      z.string(),
      z
        .object({
          line: z.number().int().positive(),
          commit: z.string(),
          author: z.string().optional(),
          date: z.string().optional(),
          summary: z.string().optional(),
        })
        .strict()
        .array(),
    ),
    codeowners: z.object({ path: z.string().optional(), lines: z.string().array() }).strict(),
    change_analysis: z
      .object({
        files_changed: z.number().int().nonnegative(),
        files_analyzed: z.number().int().nonnegative(),
        symbols_detected: z.number().int().nonnegative(),
        files_truncated: z.boolean(),
        symbols_truncated: z.boolean(),
        symbol_locations: z
          .object({
            file_path: z.string(),
            status: z.string(),
            name: z.string(),
            type: z.string(),
            start: positionSchema,
            end: positionSchema,
          })
          .strict()
          .array(),
        errors: z.string().array(),
      })
      .strict(),
    truncated: z.boolean(),
    source_is_untrusted: z.literal(true),
    secrets_redacted: z.boolean(),
    errors: z.string().array(),
  })
  .strict();

export const gitContextOutputSchema = createFeatureResultSchema(gitContextDataSchema);
