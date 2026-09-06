import { z } from "zod";

import { LOCAL_STATE_VERSION } from "@core/local-state";
import { createFeatureResultSchema } from "@features/utils";

export const MEMORY_FILE = "project-memory.json";
export const MAX_MEMORY_RECORDS = 500;
const MAX_MEMORY_BODY = 20_000;
const MAX_MEMORY_TITLE = 200;
const MEMORY_KINDS = [
  "decision",
  "constraint",
  "fact",
  "todo",
  "note",
] as const;
const DEFAULT_MEMORY_SCOPE = "project";
export const revisionStateSchema = z.enum(["current", "stale", "unknown"]);
const dateTimeSchema = z
  .string()
  .trim()
  .max(100)
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: "must be a valid date/time",
  });
const memoryScopeSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/iu)
  .describe(
    "Local memory namespace; it never crosses the selected project root",
  );
const LINK_KINDS = [
  "references",
  "implements",
  "supersedes",
  "blocks",
  "related",
] as const;

export const memoryLinkSchema = z
  .object({
    kind: z.enum(LINK_KINDS),
    target: z.string().trim().min(1).max(500),
  })
  .strict();

export const memoryRecordSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/iu),
    scope: memoryScopeSchema.default(DEFAULT_MEMORY_SCOPE),
    kind: z.enum(MEMORY_KINDS),
    title: z.string().min(1).max(MAX_MEMORY_TITLE),
    body: z.string().max(MAX_MEMORY_BODY),
    tags: z.string().array().max(16),
    links: memoryLinkSchema.array().max(20),
    created_at: z.string(),
    updated_at: z.string(),
    source_revision: z.string().max(200).optional(),
    expires_at: dateTimeSchema.optional(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const memoryStoreSchema = z
  .object({
    version: z.literal(LOCAL_STATE_VERSION),
    updated_at: z.string(),
    records: memoryRecordSchema.array().max(MAX_MEMORY_RECORDS),
  })
  .strict();

const baseMemoryInput = {
  directory: z.string().optional().default(".").describe("Project directory"),
  scope: memoryScopeSchema
    .optional()
    .default(DEFAULT_MEMORY_SCOPE)
    .describe("Local memory namespace isolated inside this project"),
};

export const getProjectMemorySchema = z.object({
  ...baseMemoryInput,
  query: z
    .string()
    .trim()
    .max(500)
    .optional()
    .default("")
    .describe("Optional words to find in titles, notes, tags, or links"),
  search_mode: z
    .enum(["hybrid", "lexical"])
    .optional()
    .default("hybrid")
    .describe("Use weighted phrase/field matching or simple lexical matching"),
  kind: z.enum(MEMORY_KINDS).optional().describe("Filter by memory kind"),
  tags: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .array()
    .max(16)
    .optional()
    .default([])
    .describe("Require all of these tags"),
  include_expired: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include records whose expiry date has passed"),
  min_confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0)
    .describe("Exclude memories below this confidence threshold"),
  limit: z.number().int().positive().max(100).optional().default(50),
  cursor: z.string().max(1_024).optional(),
  redact_secrets: z
    .boolean()
    .optional()
    .default(true)
    .describe("Redact common inline secrets in returned notes"),
});

export type GetProjectMemoryInput = z.input<typeof getProjectMemorySchema>;

const getProjectMemoryDataSchema = z
  .object({
    directory: z.string(),
    scope: z.string(),
    memory_file: z.string(),
    state: z.enum(["missing", "ready"]),
    query: z.string(),
    search_mode: z.enum(["hybrid", "lexical"]),
    records_total: z.number().int().nonnegative(),
    records_returned: z.number().int().nonnegative(),
    cursor_offset: z.number().int().nonnegative(),
    next_cursor: z.string().optional(),
    truncated: z.boolean(),
    source_is_untrusted: z.literal(true),
    secrets_redacted: z.boolean(),
    store_revision: z.string(),
    current_revision: z.string().optional(),
    revision_summary: z
      .object({
        current: z.number().int().nonnegative(),
        stale: z.number().int().nonnegative(),
        unknown: z.number().int().nonnegative(),
      })
      .strict(),
    records: memoryRecordSchema
      .extend({ revision_state: revisionStateSchema })
      .strict()
      .array(),
    errors: z.string().array(),
  })
  .strict();

export const getProjectMemoryOutputSchema = createFeatureResultSchema(
  getProjectMemoryDataSchema,
);

const upsertMemorySchema = z.object({
  ...baseMemoryInput,
  operation: z.literal("upsert"),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/iu),
  kind: z.enum(MEMORY_KINDS),
  title: z.string().trim().min(1).max(MAX_MEMORY_TITLE),
  body: z.string().max(MAX_MEMORY_BODY),
  tags: z.string().trim().min(1).max(64).array().max(16).optional().default([]),
  links: memoryLinkSchema.array().max(20).optional().default([]),
  source_revision: z.string().trim().max(200).optional(),
  capture_source_revision: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Capture the current local Git HEAD when source_revision is omitted",
    ),
  expires_at: dateTimeSchema.optional(),
  confidence: z.number().min(0).max(1).optional().default(0.7),
  expected_updated_at: z.string().optional(),
  redact_secrets: z.boolean().optional().default(true),
});

const deleteMemorySchema = z.object({
  ...baseMemoryInput,
  operation: z.literal("delete"),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/iu),
  expected_updated_at: z.string().optional(),
});

export const setProjectMemorySchema = z.discriminatedUnion("operation", [
  upsertMemorySchema,
  deleteMemorySchema,
]);

export type SetProjectMemoryInput = z.input<typeof setProjectMemorySchema>;

const setProjectMemoryDataSchema = z
  .object({
    directory: z.string(),
    scope: z.string(),
    memory_file: z.string(),
    operation: z.enum(["upsert", "delete"]),
    id: z.string(),
    deleted: z.boolean().optional(),
    record: memoryRecordSchema.optional(),
    records_count: z.number().int().nonnegative(),
    store_revision: z.string(),
    source_is_untrusted: z.literal(true),
    secrets_redacted: z.boolean(),
  })
  .strict();

export const setProjectMemoryOutputSchema = createFeatureResultSchema(
  setProjectMemoryDataSchema,
);

export type MemoryStore = z.infer<typeof memoryStoreSchema>;
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type MemoryLink = z.infer<typeof memoryLinkSchema>;
export type RevisionState = z.infer<typeof revisionStateSchema>;
