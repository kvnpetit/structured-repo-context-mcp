/**
 * Update Index Feature
 *
 * Incrementally updates the codebase index by:
 * 1. Detecting files that have changed since last indexing
 * 2. Re-indexing only the changed files
 * 3. Removing deleted files from the index
 *
 * Uses SHA-256 hash comparison to detect real content changes.
 */

import { z } from "zod";
import * as path from "node:path";
import type { Feature, FeatureExecutionContext, FeatureResult } from "@features/types";
import { EMBEDDING_CONFIG } from "@config";
import {
  chunkFile,
  createOllamaClient,
  createLexicalEmbeddingClient,
  createVectorStore,
  computeSourceFingerprint,
  enrichChunksFromFile,
  validateEmbeddingBatch,
  type EmbeddedChunk,
  type EnrichmentOptions,
} from "@core/embeddings";
import { computeContentHash, readHashCache, writeHashCache } from "@core/embeddings/hash-cache";
import { collectFiles, createIgnoreFilter } from "@core/files";
import { readPathAliasesCached } from "@core/utils";
import { readSecureTextFile, resolveSecureDirectory, safeErrorMessage } from "@core/security";
import { createFeatureResultSchema } from "@features/utils";
import { buildDryRunMessage, buildResultMessage } from "./messages";

/** Default concurrency for parallel file processing */
const DEFAULT_CONCURRENCY = 4;

export const updateIndexSchema = z.object({
  directory: z.string().optional().default(".").describe("Path to the indexed directory"),
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe("Only report changes without updating the index"),
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe("Force re-index of all files (ignore hash cache)"),
  concurrency: z
    .number()
    .int()
    .positive()
    .max(32)
    .optional()
    .default(DEFAULT_CONCURRENCY)
    .describe("Number of files to process in parallel (default: 4)"),
});

export type UpdateIndexInput = z.input<typeof updateIndexSchema>;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation cancelled");
  }
}

type HashCache = Record<string, string>;

interface UpdateResult {
  directory: string;
  dryRun: boolean;
  added: string[];
  modified: string[];
  removed: string[];
  unchanged: number;
  errors: string[];
}

const updateIndexDataSchema = z
  .object({
    directory: z.string(),
    dryRun: z.boolean(),
    added: z.string().array(),
    modified: z.string().array(),
    removed: z.string().array(),
    unchanged: z.number().int().nonnegative(),
    errors: z.string().array(),
  })
  .strict();

export const updateIndexOutputSchema = createFeatureResultSchema(updateIndexDataSchema);

/**
 * Load hash cache from disk
 */
function loadHashCache(directory: string): HashCache {
  const result = readHashCache(directory);
  return result.valid ? result.cache : {};
}

/**
 * Save hash cache to disk
 */
async function saveHashCache(
  directory: string,
  cache: HashCache,
  vectorStore: unknown,
): Promise<void> {
  const setSourceFingerprint = (
    vectorStore as {
      setSourceFingerprint?: (fingerprint: string) => void;
    }
  ).setSourceFingerprint;
  await writeHashCache(directory, cache, () => {
    if (typeof setSourceFingerprint === "function") {
      setSourceFingerprint.call(vectorStore, computeSourceFingerprint(cache));
    }
  });
}

/**
 * Process files in parallel with a concurrency limit
 */
async function parallelMap<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: (R | undefined)[] = new Array<R | undefined>(items.length);
  let currentIndex = 0;
  let stopped = false;

  const worker = async (): Promise<void> => {
    while (!stopped && currentIndex < items.length) {
      const index = currentIndex++;
      const item = items[index];
      if (item !== undefined) {
        try {
          results[index] = await processor(item);
        } catch (error) {
          stopped = true;
          throw error;
        }
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => worker());
  await Promise.all(workers);

  return results.filter((r): r is R => r !== undefined);
}

/**
 * Execute the update_index feature
 */
export async function execute(
  input: UpdateIndexInput,
  context?: FeatureExecutionContext,
): Promise<FeatureResult> {
  const { directory, dryRun, force, concurrency } = updateIndexSchema.parse(input);

  if (context?.signal?.aborted) {
    return { success: false, error: "Operation cancelled" };
  }

  const secureDirectory = resolveSecureDirectory(directory);
  if (!secureDirectory.ok) {
    return {
      success: false,
      error:
        secureDirectory.error === "Path not found" ? "Directory not found" : secureDirectory.error,
    };
  }

  const absoluteDir = secureDirectory.path;

  // Initialize components
  const ollamaClient = createOllamaClient(EMBEDDING_CONFIG);
  const embeddingClient =
    EMBEDDING_CONFIG.embeddingProvider === "lexical"
      ? createLexicalEmbeddingClient(EMBEDDING_CONFIG.embeddingDimensions)
      : ollamaClient;
  const vectorStore = createVectorStore(absoluteDir, EMBEDDING_CONFIG);

  // Check if index exists
  if (!vectorStore.exists()) {
    return {
      success: false,
      error: "No index found for directory. Run index_codebase first.",
    };
  }

  const result: UpdateResult = {
    directory: absoluteDir,
    dryRun,
    added: [],
    modified: [],
    removed: [],
    unchanged: 0,
    errors: [],
  };

  try {
    // Check Ollama health (only if not dry run)
    if (!dryRun) {
      const health = await embeddingClient.healthCheck();
      if (!health.ok) {
        return {
          success: false,
          error: health.error ?? "Ollama is not available",
        };
      }
    }

    // Connect to vector store
    await vectorStore.connect();
    throwIfAborted(context?.signal);
    try {
      vectorStore.assertMetadataCompatible();
    } catch (error) {
      if (!force || dryRun) {
        throw error;
      }
      // An explicit force update is the consent boundary for rebuilding an
      // index whose provider/model/dimensions no longer match the workspace.
      await vectorStore.clear();
    }

    // Load hash cache
    const hashCache = force ? {} : loadHashCache(absoluteDir);
    // Start from the last committed cache. This preserves old hashes for
    // files whose replacement fails, so the next update retries them instead
    // of silently considering a failed update complete.
    // Collect current files
    const ig = createIgnoreFilter(absoluteDir);
    const currentFiles = new Set(
      collectFiles(absoluteDir, ig, absoluteDir).sort((left, right) => left.localeCompare(right)),
    );
    const newHashCache: HashCache = {};
    for (const [cachedFile, hash] of Object.entries(hashCache)) {
      if (currentFiles.has(cachedFile)) {
        newHashCache[cachedFile] = hash;
      }
    }

    // Get indexed files from vector store
    const indexedFiles = new Set(await vectorStore.getIndexedFiles());

    // Find files to add/modify/remove
    const filesToProcess: { path: string; type: "add" | "modify" }[] = [];

    for (const filePath of currentFiles) {
      throwIfAborted(context?.signal);
      const readResult = readSecureTextFile(filePath, absoluteDir);
      if (!readResult.ok || readResult.content === undefined) {
        const readError = readResult.ok ? "File cannot be read" : readResult.error;
        result.errors.push(`Cannot read ${path.relative(absoluteDir, filePath)}: ${readError}`);
        continue;
      }
      const content = readResult.content;
      const hash = computeContentHash(content);

      if (!indexedFiles.has(filePath)) {
        // New file
        result.added.push(path.relative(absoluteDir, filePath));
        filesToProcess.push({ path: filePath, type: "add" });
      } else if (hashCache[filePath] !== hash) {
        // Modified file
        result.modified.push(path.relative(absoluteDir, filePath));
        filesToProcess.push({ path: filePath, type: "modify" });
      } else {
        newHashCache[filePath] = hash;
        result.unchanged++;
      }
    }

    // Find removed files
    for (const filePath of indexedFiles) {
      throwIfAborted(context?.signal);
      if (!currentFiles.has(filePath)) {
        result.removed.push(path.relative(absoluteDir, filePath));
      }
    }
    // If dry run, just report what would be done
    if (dryRun) {
      vectorStore.close();

      const message = buildDryRunMessage(result);
      return {
        success: true,
        message,
        data: result,
      };
    }

    // Read path aliases from tsconfig.json if present
    const pathAliases = readPathAliasesCached(absoluteDir);

    // Enrichment options
    const enrichmentOptions: EnrichmentOptions = {
      projectRoot: absoluteDir,
      pathAliases,
      includeCrossFileContext: true,
    };

    // Process files in parallel with concurrency limit
    interface FileProcessResult {
      filePath: string;
      hash: string;
      chunks: EmbeddedChunk[];
      error?: string;
    }

    const processFile = async ({
      path: filePath,
    }: {
      path: string;
      type: "add" | "modify";
    }): Promise<FileProcessResult> => {
      try {
        throwIfAborted(context?.signal);
        const readResult = readSecureTextFile(filePath, absoluteDir);
        if (!readResult.ok || readResult.content === undefined) {
          const readError = readResult.ok ? "File cannot be read" : readResult.error;
          return {
            filePath,
            hash: "",
            chunks: [],
            error: `Error processing ${path.relative(absoluteDir, filePath)}: ${readError}`,
          };
        }
        const content = readResult.content;
        const hash = computeContentHash(content);
        const chunks = await chunkFile(filePath, content, EMBEDDING_CONFIG);

        if (chunks.length === 0) {
          return { filePath, hash, chunks: [] };
        }

        const enrichedChunks = await enrichChunksFromFile(chunks, content, enrichmentOptions);

        const texts = enrichedChunks.map((c) => c.enrichedContent);
        const embeddings = await embeddingClient.embedBatch(texts);
        throwIfAborted(context?.signal);
        validateEmbeddingBatch(embeddings, texts.length, EMBEDDING_CONFIG.embeddingDimensions);

        const embedded: EmbeddedChunk[] = [];
        for (let i = 0; i < enrichedChunks.length; i++) {
          const chunk = enrichedChunks[i];
          const vector = embeddings[i];
          if (chunk && vector) {
            embedded.push({
              id: chunk.id,
              content: chunk.content,
              filePath: chunk.filePath,
              language: chunk.language,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              symbolName: chunk.symbolName,
              symbolType: chunk.symbolType,
              vector,
            });
          }
        }
        return { filePath, hash, chunks: embedded };
      } catch (err) {
        if (context?.signal?.aborted) {
          throw new Error("Operation cancelled");
        }
        const errorMsg = safeErrorMessage(err, "File processing failed");
        return {
          filePath,
          hash: "",
          chunks: [],
          error: `Error processing ${path.relative(absoluteDir, filePath)}: ${errorMsg}`,
        };
      }
    };

    let processedFiles = 0;
    const fileResults = await parallelMap(
      filesToProcess,
      async (file) => {
        const fileResult = await processFile(file);
        throwIfAborted(context?.signal);
        processedFiles += 1;
        await context?.reportProgress?.(
          processedFiles,
          filesToProcess.length,
          `Processed ${String(processedFiles)} of ${String(filesToProcess.length)} files`,
        );
        return fileResult;
      },
      concurrency,
    );

    const replacements = new Map<string, EmbeddedChunk[]>();
    throwIfAborted(context?.signal);
    for (const fileResult of fileResults) {
      if (fileResult.error) {
        result.errors.push(fileResult.error);
      } else {
        replacements.set(fileResult.filePath, fileResult.chunks);
        newHashCache[fileResult.filePath] = fileResult.hash;
      }
    }

    // Deleted files participate in the same atomic replacement transaction.
    for (const relativePath of result.removed) {
      const filePath = path.join(absoluteDir, relativePath);
      replacements.set(filePath, []);
    }

    if (replacements.size > 0) {
      throwIfAborted(context?.signal);
      await vectorStore.replaceFilesChunks(replacements);
    }

    // Save new hash cache
    throwIfAborted(context?.signal);
    await saveHashCache(absoluteDir, newHashCache, vectorStore);

    vectorStore.close();

    const message = buildResultMessage(result);

    return {
      success: true,
      message,
      data: result,
    };
  } catch (err) {
    vectorStore.close();
    const errorMsg = safeErrorMessage(err, "Index update operation failed");
    return {
      success: false,
      error: `Update failed: ${errorMsg}`,
    };
  }
}

export const updateIndexFeature: Feature<typeof updateIndexSchema> = {
  name: "update_index",
  description:
    "Refresh the search index after code changes. USE THIS instead of re-indexing - it's fast because it only processes changed files (SHA-256 hash detection). Use dryRun=true to preview changes first.",
  schema: updateIndexSchema,
  outputSchema: updateIndexOutputSchema,
  execute,
};
