import { z } from "zod";

import { createFeatureResultSchema } from "@features/utils";

export const MAX_SNAPSHOT_FILES = 100_000;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_BYTES = 500 * 1024 * 1024;
export const SNAPSHOT_ID_PATTERN = /^snapshot-[a-z0-9-]{8,80}$/u;

const snapshotFileSchema = z
  .object({
    path: z.string().min(1).max(1_000),
    size_bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const snapshotManifestSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(SNAPSHOT_ID_PATTERN),
    created_at: z.string(),
    source_revision: z.string().optional(),
    total_bytes: z.number().int().nonnegative(),
    files: snapshotFileSchema.array().max(MAX_SNAPSHOT_FILES),
    complete: z.literal(true),
  })
  .strict();

const commonInput = {
  directory: z.string().optional().default(".").describe("Project directory"),
  max_snapshot_bytes: z
    .number()
    .int()
    .positive()
    .max(MAX_SNAPSHOT_BYTES)
    .optional()
    .default(DEFAULT_SNAPSHOT_BYTES)
    .describe("Maximum size of a single local snapshot"),
  list_limit: z.number().int().positive().max(100).optional().default(50),
};

export const indexSnapshotsSchema = z.discriminatedUnion("operation", [
  z.object({ ...commonInput, operation: z.literal("snapshot") }),
  z.object({
    ...commonInput,
    operation: z.literal("restore"),
    snapshot_id: z.string().regex(SNAPSHOT_ID_PATTERN),
    backup_current: z.boolean().optional().default(true),
  }),
  z.object({
    ...commonInput,
    operation: z.literal("cleanup"),
    max_snapshots: z
      .number()
      .int()
      .nonnegative()
      .max(100)
      .optional()
      .default(10),
    max_total_bytes: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_SNAPSHOT_BYTES)
      .optional()
      .default(DEFAULT_SNAPSHOT_BYTES),
  }),
  z.object({ ...commonInput, operation: z.literal("list") }),
]);

export type IndexSnapshotsInput = z.input<typeof indexSnapshotsSchema>;

const snapshotSummarySchema = z
  .object({
    id: z.string(),
    created_at: z.string(),
    source_revision: z.string().optional(),
    file_count: z.number().int().nonnegative(),
    total_bytes: z.number().int().nonnegative(),
    valid: z.boolean(),
  })
  .strict();

const indexSnapshotsDataSchema = z
  .object({
    directory: z.string(),
    index_directory: z.string(),
    snapshot_directory: z.string(),
    operation: z.enum(["snapshot", "restore", "cleanup", "list"]),
    snapshot_id: z.string().optional(),
    backup_snapshot_id: z.string().optional(),
    restored: z.boolean(),
    deleted_snapshots: z.string().array(),
    snapshots: snapshotSummarySchema.array(),
    total_snapshot_bytes: z.number().int().nonnegative(),
    quota_bytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    source_is_untrusted: z.literal(true),
    secrets_redacted: z.literal(true),
    errors: z.string().array(),
  })
  .strict();

export const indexSnapshotsOutputSchema = createFeatureResultSchema(
  indexSnapshotsDataSchema,
);

export type SnapshotFile = z.infer<typeof snapshotFileSchema>;
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;
export type SnapshotSummary = z.infer<typeof snapshotSummarySchema>;
