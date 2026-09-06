import { z } from "zod";

import { EMBEDDING_CONFIG } from "@config";
import {
  createVectorStore,
  type IndexMaintenanceStatus,
  type IndexOptimizationStats,
} from "@core/embeddings";
import { resolveSecureDirectory, safeErrorMessage } from "@core/security";
import type { Feature, FeatureResult } from "@features/types";
import { createFeatureResultSchema } from "@features/utils";

const maintenanceOperations = ["inspect", "compact", "migrate"] as const;

export const indexMaintenanceSchema = z.object({
  directory: z.string().optional().default(".").describe("Project directory"),
  operation: z
    .enum(maintenanceOperations)
    .optional()
    .default("inspect")
    .describe(
      "Inspect the local index, compact its fragments, or migrate local Lance manifests",
    ),
  cleanup_older_than_days: z
    .number()
    .int()
    .min(0)
    .max(3_650)
    .optional()
    .default(7)
    .describe("For compaction, prune table versions older than this many days"),
  delete_unverified: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "For compaction, remove unverified fragments after a safe snapshot",
    ),
});

export type IndexMaintenanceInput = z.input<typeof indexMaintenanceSchema>;

const maintenanceStatusSchema = z
  .object({
    table_present: z.boolean(),
    table_version: z.number().int().nonnegative().optional(),
    version_count: z.number().int().nonnegative(),
    total_bytes: z.number().int().nonnegative(),
    rows: z.number().int().nonnegative(),
    fragment_count: z.number().int().nonnegative(),
    small_fragment_count: z.number().int().nonnegative(),
    indices: z.string().array(),
    manifest_paths_v2: z.boolean().optional(),
    metadata_schema_version: z.number().int().nonnegative().optional(),
    metadata_compatible: z.boolean(),
    metadata_error: z.string().optional(),
  })
  .strict();

const optimizationSchema = z
  .object({
    compaction: z
      .object({
        fragments_removed: z.number().int().nonnegative(),
        fragments_added: z.number().int().nonnegative(),
        files_removed: z.number().int().nonnegative(),
        files_added: z.number().int().nonnegative(),
      })
      .strict(),
    prune: z
      .object({
        bytes_removed: z.number().int().nonnegative(),
        old_versions_removed: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const indexMaintenanceDataSchema = z
  .object({
    directory: z.string(),
    operation: z.enum(maintenanceOperations),
    index_present: z.boolean(),
    changed: z.boolean(),
    before: maintenanceStatusSchema,
    after: maintenanceStatusSchema,
    optimization: optimizationSchema.optional(),
    manifest_paths_v2_migrated: z.boolean(),
    source_is_untrusted: z.literal(true),
    secrets_redacted: z.literal(true),
    warnings: z.string().array(),
  })
  .strict();

export const indexMaintenanceOutputSchema = createFeatureResultSchema(
  indexMaintenanceDataSchema,
);

type MaintenanceStatusOutput = z.infer<typeof maintenanceStatusSchema>;

function emptyStatus(): MaintenanceStatusOutput {
  return {
    table_present: false,
    version_count: 0,
    total_bytes: 0,
    rows: 0,
    fragment_count: 0,
    small_fragment_count: 0,
    indices: [],
    metadata_compatible: true,
  };
}

function formatStatus(status: IndexMaintenanceStatus): MaintenanceStatusOutput {
  return {
    table_present: status.tablePresent,
    ...(status.tableVersion === undefined
      ? {}
      : { table_version: status.tableVersion }),
    version_count: status.versionCount,
    total_bytes: status.totalBytes,
    rows: status.rows,
    fragment_count: status.fragmentCount,
    small_fragment_count: status.smallFragmentCount,
    indices: status.indices,
    ...(status.manifestPathsV2 === undefined
      ? {}
      : { manifest_paths_v2: status.manifestPathsV2 }),
    ...(status.metadataSchemaVersion === undefined
      ? {}
      : { metadata_schema_version: status.metadataSchemaVersion }),
    metadata_compatible: status.metadataCompatible,
    ...(status.metadataError === undefined
      ? {}
      : { metadata_error: status.metadataError }),
  };
}

function formatOptimization(
  stats: IndexOptimizationStats,
): z.infer<typeof optimizationSchema> {
  return {
    compaction: {
      fragments_removed: stats.compaction.fragmentsRemoved,
      fragments_added: stats.compaction.fragmentsAdded,
      files_removed: stats.compaction.filesRemoved,
      files_added: stats.compaction.filesAdded,
    },
    prune: {
      bytes_removed: stats.prune.bytesRemoved,
      old_versions_removed: stats.prune.oldVersionsRemoved,
    },
  };
}

export async function execute(
  rawInput: IndexMaintenanceInput,
): Promise<FeatureResult> {
  const input = indexMaintenanceSchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }

  const directory = secureDirectory.path;
  const store = createVectorStore(directory, EMBEDDING_CONFIG);
  if (!store.exists()) {
    const before = emptyStatus();
    if (input.operation !== "inspect") {
      return {
        success: false,
        error: "No local index found for directory; run index_codebase first.",
      };
    }
    const data = {
      directory,
      operation: input.operation,
      index_present: false,
      changed: false,
      before,
      after: before,
      manifest_paths_v2_migrated: false,
      source_is_untrusted: true as const,
      secrets_redacted: true as const,
      warnings: ["No local Lance index table is present"],
    };
    return {
      success: true,
      message: "Local index is not present",
      data,
    };
  }

  try {
    await store.connect();
    const before = formatStatus(await store.getMaintenanceStatus());
    const warnings = before.metadata_error ? [before.metadata_error] : [];
    let optimization: z.infer<typeof optimizationSchema> | undefined;
    let migrated = false;

    if (input.operation === "compact") {
      if (!before.metadata_compatible) {
        return {
          success: false,
          error:
            before.metadata_error ??
            "Index metadata is incompatible; rebuild before compacting",
        };
      }
      const result = await store.optimizeIndex(
        input.cleanup_older_than_days,
        input.delete_unverified,
      );
      optimization = formatOptimization(result);
    } else if (input.operation === "migrate") {
      migrated = await store.migrateIndexStorage();
      if (before.manifest_paths_v2 === undefined) {
        warnings.push(
          "The installed LanceDB runtime does not report manifest path status",
        );
      }
    }

    const after = formatStatus(await store.getMaintenanceStatus());
    const changed =
      migrated ||
      (optimization !== undefined &&
        (optimization.compaction.fragments_removed > 0 ||
          optimization.compaction.fragments_added > 0 ||
          optimization.compaction.files_removed > 0 ||
          optimization.compaction.files_added > 0 ||
          optimization.prune.bytes_removed > 0 ||
          optimization.prune.old_versions_removed > 0));
    const data = {
      directory,
      operation: input.operation,
      index_present: true,
      changed,
      before,
      after,
      ...(optimization === undefined ? {} : { optimization }),
      manifest_paths_v2_migrated: migrated,
      source_is_untrusted: true as const,
      secrets_redacted: true as const,
      warnings,
    };
    return {
      success: true,
      message: `Local index ${input.operation} completed${changed ? " with changes" : " without changes"}`,
      data,
    };
  } catch (error) {
    return {
      success: false,
      error: safeErrorMessage(error, "Local index maintenance failed"),
    };
  } finally {
    store.close();
  }
}

export const indexMaintenanceFeature: Feature<typeof indexMaintenanceSchema> = {
  name: "maintain_index",
  title: "Maintain the local index",
  description:
    "Inspect, compact, and migrate the local LanceDB index with bounded, explicit maintenance operations; no project code is executed.",
  schema: indexMaintenanceSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  outputSchema: indexMaintenanceOutputSchema,
  execute,
};
