/**
 * Search Code Feature
 *
 * Performs semantic search on indexed codebase using:
 * 1. Query embedding via Ollama
 * 2. Vector similarity search via LanceDB
 */

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Feature, FeatureResult } from "@features/types";
import { EMBEDDING_CONFIG } from "@config";
import {
  createOllamaClient,
  createVectorStore,
  type SearchResult,
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
  const { query, directory, limit, threshold } = input;

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

    // Search for similar chunks
    let results = await vectorStore.search(queryVector, limit);

    // Apply threshold filter if specified
    if (threshold !== undefined) {
      results = results.filter((r) => r.score <= threshold);
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
    "Search indexed codebase using natural language. Returns semantically similar code chunks.",
  schema: searchCodeSchema,
  execute,
};
