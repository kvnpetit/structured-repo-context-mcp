/**
 * Search Code Feature
 *
 * Performs hybrid search on indexed codebase combining:
 * 1. Vector similarity search (semantic embeddings via Ollama)
 * 2. Full-text search (BM25 keyword matching)
 * 3. RRF (Reciprocal Rank Fusion) to combine results
 *
 * Supports three search modes:
 * - 'hybrid' (default): Best of both vector and keyword search
 * - 'vector': Semantic search only
 * - 'fts': Keyword search only
 */

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Feature, FeatureResult } from "@features/types";
import { EMBEDDING_CONFIG } from "@config";
import {
  createOllamaClient,
  createVectorStore,
  rerank,
  type SearchResult,
  type SearchMode,
} from "@core/embeddings";

export const searchCodeSchema = z.object({
  query: z.string().min(1).describe("Natural language search query"),
  directory: z
    .string()
    .optional()
    .default(".")
    .describe("Path to the indexed directory (defaults to current directory)"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .default(10)
    .describe("Maximum number of results to return"),
  threshold: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe("Maximum distance threshold for results (lower = more similar)"),
  mode: z
    .enum(["vector", "fts", "hybrid"])
    .optional()
    .default("hybrid")
    .describe(
      "Search mode: 'vector' (semantic only), 'fts' (keyword only), 'hybrid' (combined with RRF fusion)",
    ),
  rerank: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Enable LLM re-ranking for improved relevance (requires Ollama with llama3.2 model)",
    ),
});

export type SearchCodeInput = z.infer<typeof searchCodeSchema>;

interface FormattedResult {
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  symbolName?: string;
  symbolType?: string;
}

interface SearchOutput {
  query: string;
  directory: string;
  resultsCount: number;
  results: FormattedResult[];
}

/**
 * Format search results for output
 */
function formatResults(
  results: SearchResult[],
  baseDir: string,
): FormattedResult[] {
  return results.map((r) => ({
    filePath: path.relative(baseDir, r.chunk.filePath),
    language: r.chunk.language,
    startLine: r.chunk.startLine,
    endLine: r.chunk.endLine,
    content: r.chunk.content,
    score: r.score,
    symbolName: r.chunk.symbolName,
    symbolType: r.chunk.symbolType,
  }));
}

/**
 * Execute the search_code feature
 */
export async function execute(input: SearchCodeInput): Promise<FeatureResult> {
  const {
    query,
    directory,
    limit,
    threshold,
    mode,
    rerank: enableRerank,
  } = input;

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

  // Check if index exists
  if (!vectorStore.exists()) {
    return {
      success: false,
      error: `No index found for directory. Run index_codebase first: ${absoluteDir}`,
    };
  }

  try {
    // Check Ollama health
    const health = await ollamaClient.healthCheck();
    if (!health.ok) {
      return {
        success: false,
        error: health.error ?? "Ollama is not available",
      };
    }

    // Connect to vector store
    await vectorStore.connect();

    // Generate query embedding
    const queryVector = await ollamaClient.embed(query);

    // Search for similar chunks using hybrid search (vector + BM25 + RRF)
    let results = await vectorStore.searchHybrid(queryVector, query, limit, {
      mode: mode as SearchMode,
    });

    // Apply threshold filter if specified (only for vector mode where lower = better)
    // For hybrid/fts modes, RRF scores are higher = better, so threshold is ignored
    if (threshold !== undefined && mode === "vector") {
      results = results.filter((r) => r.score <= threshold);
    }

    // Apply LLM re-ranking if enabled
    if (enableRerank && results.length > 0) {
      results = await rerank(query, results, {
        ollamaBaseUrl: EMBEDDING_CONFIG.ollamaBaseUrl,
        maxResults: limit,
      });
    }

    vectorStore.close();

    const formattedResults = formatResults(results, absoluteDir);

    const output: SearchOutput = {
      query,
      directory: absoluteDir,
      resultsCount: formattedResults.length,
      results: formattedResults,
    };

    if (formattedResults.length === 0) {
      return {
        success: true,
        message: "No matching code found",
        data: output,
      };
    }

    // Build text message with results
    const resultLines = formattedResults.map((r, i) => {
      const location = `${r.filePath}:${String(r.startLine)}-${String(r.endLine)}`;
      const symbol = r.symbolName
        ? ` (${r.symbolType ?? "symbol"}: ${r.symbolName})`
        : "";
      const preview = r.content.slice(0, 100).replace(/\n/g, " ");
      return `${String(i + 1)}. [${r.language}] ${location}${symbol}\n   ${preview}...`;
    });

    const message = `Found ${String(formattedResults.length)} results for "${query}":\n\n${resultLines.join("\n\n")}`;

    return {
      success: true,
      message,
      data: output,
    };
  } catch (err) {
    vectorStore.close();
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Search failed: ${errorMsg}`,
    };
  }
}

export const searchCodeFeature: Feature<typeof searchCodeSchema> = {
  name: "search_code",
  description:
    "Search indexed codebase using hybrid search (vector + BM25 + RRF fusion). Supports 'hybrid' (default), 'vector', or 'fts' modes. Optional LLM re-ranking for improved relevance.",
  schema: searchCodeSchema,
  execute,
};
