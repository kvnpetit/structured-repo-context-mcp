/**
 * Get Index Status Feature
 *
 * Returns information about the embedding index for a directory:
 * - Whether an index exists
 * - Total chunks and files indexed
 * - Language breakdown
 */

import { z } from "zod";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Feature, FeatureResult } from "@features/types";
import { EMBEDDING_CONFIG } from "@config";
import {
  createVectorStore,
  computeSourceFingerprint,
  getIndexPath,
  hasIndexData,
  type IndexStatus,
} from "@core/embeddings";
import { readHashCache } from "@core/embeddings/hash-cache";
import { readSecureTextFile, resolveSecureDirectory, safeErrorMessage } from "@core/security";
import { collectFiles, createIgnoreFilter } from "@core/files";
import { createFeatureResultSchema } from "@features/utils";

export const getIndexStatusSchema = z.object({
  directory: z
    .string()
    .optional()
    .default(".")
    .describe("Path to the directory to check (defaults to current directory)"),
});

export type GetIndexStatusInput = z.infer<typeof getIndexStatusSchema>;

export const indexMetadataSchema = z
  .object({
    schemaVersion: z.number().int().nonnegative(),
    embeddingProvider: z.enum(["ollama", "lexical", "unknown"]),
    embeddingModel: z.string(),
    embeddingDimensions: z.number().int().positive(),
    chunkSize: z.number().int().positive().optional(),
    chunkOverlap: z.number().int().nonnegative().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    sourceFingerprint: z.string().optional(),
    legacy: z.boolean().optional(),
  })
  .strict();

export const indexStatusDataSchema = z
  .object({
    directory: z.string(),
    indexPath: z.string(),
    exists: z.boolean(),
    totalChunks: z.number().int().nonnegative(),
    totalFiles: z.number().int().nonnegative(),
    languages: z.record(z.string(), z.number().int().nonnegative()),
    lastUpdated: z.string().optional(),
    metadata: indexMetadataSchema.optional(),
    metadataError: z.string().optional(),
    index_freshness: z.enum(["fresh", "stale", "unknown"]).optional(),
    storage_bytes: z.number().int().nonnegative().optional(),
    storage_scan_truncated: z.boolean().optional(),
    hash_cache_present: z.boolean().optional(),
    write_lock_present: z.boolean().optional(),
    corrupt: z.boolean().optional(),
  })
  .strict();

export const getIndexStatusOutputSchema = createFeatureResultSchema(indexStatusDataSchema);

const MAX_FRESHNESS_FILES = 20_000;
const MAX_STORAGE_ENTRIES = 100_000;

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{16,64}$/u.test(value);
}

function loadHashCache(directory: string): Record<string, string> | undefined {
  const result = readHashCache(directory);
  return result.exists && result.valid ? result.cache : undefined;
}

function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function sourceFreshness(
  directory: string,
  sourceFingerprint: string | undefined,
): "fresh" | "stale" | "unknown" {
  if (sourceFingerprint === undefined || !isFingerprint(sourceFingerprint)) {
    return "unknown";
  }
  const cache = loadHashCache(directory);
  if (cache === undefined) {
    return "unknown";
  }
  try {
    const files = collectFiles(directory, createIgnoreFilter(directory), directory).sort(
      (left, right) => left.localeCompare(right),
    );
    if (files.length > MAX_FRESHNESS_FILES) {
      return "unknown";
    }
    const current: Record<string, string> = {};
    for (const file of files) {
      const readResult = readSecureTextFile(file, directory);
      if (!readResult.ok || readResult.content === undefined) {
        return "unknown";
      }
      current[file] = contentHash(readResult.content);
    }
    const currentFingerprint = computeSourceFingerprint(current);
    return currentFingerprint === sourceFingerprint ||
      currentFingerprint.slice(0, 16) === sourceFingerprint
      ? "fresh"
      : "stale";
  } catch {
    return "unknown";
  }
}

function storageSummary(directory: string): {
  bytes: number;
  truncated: boolean;
} {
  let bytes = 0;
  let visited = 0;
  const stack = [directory];
  while (stack.length > 0 && visited < MAX_STORAGE_ENTRIES) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited >= MAX_STORAGE_ENTRIES) {
        break;
      }
      visited++;
      const child = path.join(current, entry.name);
      try {
        const stats = fs.lstatSync(child);
        if (stats.isSymbolicLink()) {
          continue;
        }
        if (stats.isDirectory()) {
          stack.push(child);
        } else if (stats.isFile()) {
          bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + stats.size);
        }
      } catch {
        // A concurrently removed file does not make status unsafe.
      }
    }
  }
  return { bytes, truncated: visited >= MAX_STORAGE_ENTRIES };
}

function enrichStatus(directory: string, indexPath: string, status: IndexStatus): IndexStatus {
  const storage = storageSummary(indexPath);
  const hashCachePresent = loadHashCache(directory) !== undefined;
  return {
    ...status,
    index_freshness: status.exists
      ? status.metadataError === undefined
        ? sourceFreshness(directory, status.metadata?.sourceFingerprint)
        : "stale"
      : "unknown",
    storage_bytes: storage.bytes,
    storage_scan_truncated: storage.truncated,
    hash_cache_present: hashCachePresent,
    write_lock_present: fs.existsSync(path.join(path.dirname(indexPath), ".src-index-write.lock")),
    corrupt: Boolean(status.metadataError),
  };
}

/**
 * Execute the get_index_status feature
 */
export async function execute(input: GetIndexStatusInput): Promise<FeatureResult> {
  const { directory } = input;

  const secureDirectory = resolveSecureDirectory(directory);
  if (!secureDirectory.ok) {
    return {
      success: false,
      error:
        secureDirectory.error === "Path not found" ? "Directory not found" : secureDirectory.error,
    };
  }

  const absoluteDir = secureDirectory.path;
  const indexPath = getIndexPath(absoluteDir);

  // Check if index exists
  if (!hasIndexData(absoluteDir)) {
    const status: IndexStatus = {
      directory: absoluteDir,
      indexPath,
      exists: false,
      totalChunks: 0,
      totalFiles: 0,
      languages: {},
      index_freshness: "unknown",
      storage_bytes: 0,
      storage_scan_truncated: false,
      hash_cache_present: false,
      write_lock_present: false,
      corrupt: false,
    };

    return {
      success: true,
      message: "No index found. Run index_codebase to create one.",
      data: status,
    };
  }

  const vectorStore = createVectorStore(absoluteDir, EMBEDDING_CONFIG);
  try {
    await vectorStore.connect();

    const status = enrichStatus(absoluteDir, indexPath, await vectorStore.getStatus(absoluteDir));

    // Format language breakdown
    const languageLines = Object.entries(status.languages)
      .sort(([, a], [, b]) => b - a)
      .map(([lang, count]) => `  - ${lang}: ${String(count)} chunks`);

    const message = [
      `Index Status for ${absoluteDir}`,
      ``,
      `Index Path: ${status.indexPath}`,
      `Total Files: ${String(status.totalFiles)}`,
      `Total Chunks: ${String(status.totalChunks)}`,
      ``,
      `Languages:`,
      ...languageLines,
    ].join("\n");

    return {
      success: true,
      message,
      data: status,
    };
  } catch (err) {
    const errorMsg = safeErrorMessage(err, "Index status operation failed");
    return {
      success: false,
      error: `Failed to read index status: ${errorMsg}`,
    };
  } finally {
    vectorStore.close();
  }
}

export const getIndexStatusFeature: Feature<typeof getIndexStatusSchema> = {
  name: "get_index_status",
  description:
    "Check if a codebase is indexed and ready for search. USE THIS to verify index exists before searching. Returns file count, chunk count, and indexed languages.",
  schema: getIndexStatusSchema,
  outputSchema: getIndexStatusOutputSchema,
  execute,
};
