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
import * as fs from "node:fs";
import * as path from "node:path";
import ignore, { type Ignore } from "ignore";
import type { Feature, FeatureResult } from "@features/types";
import { EMBEDDING_CONFIG } from "@config";
import {
  createOllamaClient,
  createVectorStore,
  chunkFile,
  shouldIndexFile,
  type CodeChunk,
  type EmbeddedChunk,
} from "@core/embeddings";

export const indexCodebaseSchema = z.object({
  directory: z
    .string()
    .optional()
    .default(".")
    .describe("Path to the directory to index (defaults to current directory)"),
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe("Force re-indexing even if index exists"),
  exclude: z
    .array(z.string())
    .optional()
    .default([])
    .describe("Additional glob patterns to exclude"),
});

export type IndexCodebaseInput = z.infer<typeof indexCodebaseSchema>;

interface IndexResult {
  directory: string;
  filesIndexed: number;
  chunksCreated: number;
  languages: Record<string, number>;
  errors: string[];
}

/**
 * Create an ignore instance with gitignore patterns and additional exclusions
 */
function createIgnoreFilter(
  baseDir: string,
  additionalExclusions: string[],
): Ignore {
  const ig = ignore();

  // Read .gitignore if it exists
  const gitignorePath = path.join(baseDir, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    try {
      const content = fs.readFileSync(gitignorePath, "utf-8");
      ig.add(content);
    } catch {
      // Ignore read errors
    }
  }

  // Add additional user exclusions
  if (additionalExclusions.length > 0) {
    ig.add(additionalExclusions);
  }

  return ig;
}

/**
 * Check if a name starts with a dot (hidden file/folder)
 */
function isHidden(name: string): boolean {
  return name.startsWith(".");
}

/**
 * Recursively collect files from a directory
 */
function collectFiles(dir: string, ig: Ignore, baseDir: string): string[] {
  const files: string[] = [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden files/folders (starting with .)
    if (isHidden(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

    // Check if ignored by gitignore patterns
    if (ig.ignores(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, ig, baseDir));
    } else if (entry.isFile() && shouldIndexFile(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Execute the index_codebase feature
 */
export async function execute(
  input: IndexCodebaseInput,
): Promise<FeatureResult> {
  const { directory, force, exclude } = input;

  // Validate directory exists
  if (!fs.existsSync(directory)) {
    return {
      success: false,
      error: `Directory not found: ${directory}`,
    };
  }

  const absoluteDir = path.resolve(directory);

  // Initialize components
  const ollamaClient = createOllamaClient(EMBEDDING_CONFIG);
  const vectorStore = createVectorStore(absoluteDir, EMBEDDING_CONFIG);

  // Check Ollama health
  const health = await ollamaClient.healthCheck();
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
      error:
        "Index already exists. Use force=true to re-index or search_code to query.",
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

    // Clear existing data if force re-indexing
    if (force && vectorStore.exists()) {
      await vectorStore.clear();
    }

    // Create ignore filter from .gitignore and user exclusions
    const ig = createIgnoreFilter(absoluteDir, exclude);

    // Collect files
    const files = collectFiles(absoluteDir, ig, absoluteDir);

    if (files.length === 0) {
      return {
        success: true,
        message: "No indexable files found in directory",
        data: result,
      };
    }

    // Process files in batches
    const allChunks: CodeChunk[] = [];

    for (const filePath of files) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const chunks = await chunkFile(filePath, content, EMBEDDING_CONFIG);
        allChunks.push(...chunks);

        result.filesIndexed++;

        // Track language stats
        for (const chunk of chunks) {
          result.languages[chunk.language] =
            (result.languages[chunk.language] ?? 0) + 1;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Error processing ${filePath}: ${errorMsg}`);
      }
    }

    // Generate embeddings in batches
    const { batchSize } = EMBEDDING_CONFIG;
    const embeddedChunks: EmbeddedChunk[] = [];

    for (let i = 0; i < allChunks.length; i += batchSize) {
      const batch = allChunks.slice(i, i + batchSize);
      const texts = batch.map((c) => c.content);

      try {
        const embeddings = await ollamaClient.embedBatch(texts);

        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j];
          const vector = embeddings[j];

          if (chunk && vector) {
            embeddedChunks.push({
              ...chunk,
              vector,
            });
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Embedding batch error: ${errorMsg}`);
      }
    }

    // Store embeddings
    if (embeddedChunks.length > 0) {
      await vectorStore.addChunks(embeddedChunks);
      result.chunksCreated = embeddedChunks.length;
    }

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
    const errorMsg = err instanceof Error ? err.message : String(err);
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
    "Index a codebase directory for semantic search. Creates embeddings for all supported source files.",
  schema: indexCodebaseSchema,
  execute,
};
