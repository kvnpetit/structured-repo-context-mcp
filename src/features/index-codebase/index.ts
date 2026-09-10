/**
 * Index Codebase Feature
 *
 * Indexes a directory by:
 * 1. Scanning for supported files
 * 2. Chunking each file
 * 3. Generating embeddings via Ollama
 * 4. Storing in LanceDB
 */

import { z } from "zod";
import * as path from "node:path";
import * as crypto from "node:crypto";
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
  type EnrichedChunk,
  type EnrichmentOptions,
} from "@core/embeddings";
import { writeHashCache } from "@core/embeddings/hash-cache";
import { collectFiles, createIgnoreFilter } from "@core/files";
import { logger } from "@utils";
import { readPathAliasesCached } from "@core/utils";
import { readSecureTextFile, resolveSecureDirectory, safeErrorMessage } from "@core/security";
import { createFeatureResultSchema } from "@features/utils";

/** Default concurrency for parallel file processing */
const DEFAULT_CONCURRENCY = 4;

/** Compute a stable content hash for incremental updates */
function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/** Persist hashes only after a complete initial index has been stored */
async function saveHashCache(
  directory: string,
  cache: Record<string, string>,
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
 * Process items in parallel with concurrency limit using worker pool pattern
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

  // Filter out undefined values (shouldn't happen but TypeScript needs this)
  return results.filter((r): r is R => r !== undefined);
}

export const indexCodebaseSchema = z.object({
  directory: z
    .string()
    .optional()
    .default(".")
    .describe("Path to the directory to index (defaults to current directory)"),
  force: z.boolean().optional().default(false).describe("Force re-indexing even if index exists"),
  exclude: z
    .array(z.string())
    .optional()
    .default([])
    .describe("Additional glob patterns to exclude"),
  concurrency: z
    .number()
    .int()
    .positive()
    .max(32)
    .optional()
    .default(DEFAULT_CONCURRENCY)
    .describe("Number of files to process in parallel (default: 4)"),
});

export type IndexCodebaseInput = z.infer<typeof indexCodebaseSchema>;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation cancelled");
  }
}

interface IndexResult {
  directory: string;
  filesIndexed: number;
  chunksCreated: number;
  languages: Record<string, number>;
  errors: string[];
}

const indexCodebaseDataSchema = z
  .object({
    directory: z.string(),
    filesIndexed: z.number().int().nonnegative(),
    chunksCreated: z.number().int().nonnegative(),
    languages: z.record(z.string(), z.number().int().nonnegative()),
    errors: z.string().array(),
  })
  .strict();

export const indexCodebaseOutputSchema = createFeatureResultSchema(indexCodebaseDataSchema);

/**
 * Execute the index_codebase feature
 */
export async function execute(
  input: IndexCodebaseInput,
  context?: FeatureExecutionContext,
): Promise<FeatureResult> {
  const { directory, force, exclude, concurrency } = input;

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

  // Check Ollama health
  const health = await embeddingClient.healthCheck();
  if (!health.ok) {
    return {
      success: false,
      error: health.error ?? "Ollama is not available",
    };
  }

  // Check if index exists and force is not set
  if (vectorStore.exists() && !force) {
    return {
      success: false,
      error: "Index already exists. Use force=true to re-index or search_code to query.",
    };
  }

  const result: IndexResult = {
    directory: absoluteDir,
    filesIndexed: 0,
    chunksCreated: 0,
    languages: {},
    errors: [],
  };

  try {
    // Connect to vector store
    await vectorStore.connect();
    throwIfAborted(context?.signal);

    // Create ignore filter from .gitignore and user exclusions
    const ig = createIgnoreFilter(absoluteDir, exclude);

    // Collect files
    const files = collectFiles(absoluteDir, ig, absoluteDir).sort((left, right) =>
      left.localeCompare(right),
    );

    if (files.length === 0) {
      if (force && vectorStore.exists()) {
        await vectorStore.clear();
        await saveHashCache(absoluteDir, {}, vectorStore);
      }
      vectorStore.close();
      return {
        success: true,
        message: "No indexable files found in directory",
        data: result,
      };
    }

    // Read path aliases from tsconfig.json if present
    const pathAliases = readPathAliasesCached(absoluteDir);
    const aliasCount = Object.keys(pathAliases).length;

    // Enrichment options with cross-file context enabled
    const enrichmentOptions: EnrichmentOptions = {
      projectRoot: absoluteDir,
      pathAliases,
      includeCrossFileContext: true,
    };

    logger.debug(
      `Indexing ${String(files.length)} files with concurrency=${String(concurrency)} (projectRoot: ${absoluteDir}, ${String(aliasCount)} path aliases)`,
    );

    // Process files in parallel: chunk and enrich
    interface FileProcessResult {
      filePath: string;
      hash: string;
      chunks: EnrichedChunk[];
      error?: string;
    }

    const processFile = async (filePath: string): Promise<FileProcessResult> => {
      throwIfAborted(context?.signal);
      try {
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
        const hash = computeHash(content);
        const chunks = await chunkFile(filePath, content, EMBEDDING_CONFIG);
        throwIfAborted(context?.signal);

        // Enrich chunks with semantic metadata including cross-file context
        const enrichedChunks = await enrichChunksFromFile(chunks, content, enrichmentOptions);
        throwIfAborted(context?.signal);

        return { filePath, hash, chunks: enrichedChunks };
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

    // Process all files in parallel with concurrency limit
    let processedFiles = 0;
    const fileResults = await parallelMap(
      files,
      async (filePath) => {
        const fileResult = await processFile(filePath);
        throwIfAborted(context?.signal);
        processedFiles += 1;
        await context?.reportProgress?.(
          processedFiles,
          files.length,
          `Processed ${String(processedFiles)} of ${String(files.length)} files`,
        );
        return fileResult;
      },
      concurrency,
    );

    // Aggregate results
    throwIfAborted(context?.signal);
    const allEnrichedChunks: EnrichedChunk[] = [];
    const hashCache: Record<string, string> = {};

    for (const fileResult of fileResults) {
      if (fileResult.error) {
        result.errors.push(fileResult.error);
      } else {
        allEnrichedChunks.push(...fileResult.chunks);
        hashCache[fileResult.filePath] = fileResult.hash;
        result.filesIndexed++;

        // Track language stats
        for (const chunk of fileResult.chunks) {
          result.languages[chunk.language] = (result.languages[chunk.language] ?? 0) + 1;
        }
      }
    }

    // Generate embeddings in batches using enriched content
    const { batchSize } = EMBEDDING_CONFIG;
    const embeddedChunks: EmbeddedChunk[] = [];
    let embeddingBatchFailed = false;

    for (let i = 0; i < allEnrichedChunks.length; i += batchSize) {
      throwIfAborted(context?.signal);
      const batch = allEnrichedChunks.slice(i, i + batchSize);
      // Use enrichedContent for embedding (contains metadata header + original code)
      const texts = batch.map((c) => c.enrichedContent);

      try {
        const embeddings = await embeddingClient.embedBatch(texts);
        throwIfAborted(context?.signal);
        validateEmbeddingBatch(embeddings, texts.length, EMBEDDING_CONFIG.embeddingDimensions);

        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j];
          const vector = embeddings[j];

          if (chunk && vector) {
            // Store original chunk data (without enrichedContent to save space)
            embeddedChunks.push({
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
      } catch (err) {
        embeddingBatchFailed = true;
        const errorMsg = safeErrorMessage(err, "Embedding generation failed");
        result.errors.push(`Embedding batch error: ${errorMsg}`);
      }
    }

    if (embeddingBatchFailed) {
      throw new Error("Embedding generation failed; the existing index was not modified");
    }

    // Store embeddings
    throwIfAborted(context?.signal);
    if (force && vectorStore.exists()) {
      await vectorStore.clear();
    }
    if (embeddedChunks.length > 0) {
      await vectorStore.addChunks(embeddedChunks);
      result.chunksCreated = embeddedChunks.length;
    }

    // Keep update_index incremental immediately after the first successful index.
    await saveHashCache(absoluteDir, hashCache, vectorStore);

    vectorStore.close();

    const hasErrors = result.errors.length > 0;
    const message = hasErrors
      ? `Indexed ${String(result.filesIndexed)} files (${String(result.chunksCreated)} chunks) with ${String(result.errors.length)} errors`
      : `Successfully indexed ${String(result.filesIndexed)} files (${String(result.chunksCreated)} chunks)`;

    return {
      success: true,
      message,
      data: result,
    };
  } catch (err) {
    vectorStore.close();
    const errorMsg = safeErrorMessage(err, "Indexing operation failed");
    return {
      success: false,
      error: `Indexing failed: ${errorMsg}`,
      data: result,
    };
  }
}

export const indexCodebaseFeature: Feature<typeof indexCodebaseSchema> = {
  name: "index_codebase",
  description:
    "Index a codebase for semantic code search. USE THIS FIRST before search_code. Required once per project - creates vector embeddings for 55 configured language modes across 99 extensions. After initial indexing, use update_index for incremental updates.",
  schema: indexCodebaseSchema,
  outputSchema: indexCodebaseOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  execute,
};
