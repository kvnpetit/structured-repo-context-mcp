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
 *
 * Optional features:
 * - LLM re-ranking for improved relevance
 * - Call context to show callers/callees for each result
 */

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Feature, FeatureResult } from "@features/types";
import { EMBEDDING_CONFIG } from "@config";
import {
  createOllamaClient,
  createVectorStore,
  buildCallGraph,
  getCallContext,
  type SearchResult,
  type SearchMode,
} from "@core/embeddings";
import { collectFiles, createIgnoreFilter } from "@core/files";

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
  includeCallContext: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Include caller/callee information for each result (uses cached call graph)",
    ),
});

export type SearchCodeInput = z.infer<typeof searchCodeSchema>;

interface CallContextInfo {
  callers: string[];
  callees: string[];
}

interface FormattedResult {
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  symbolName?: string;
  symbolType?: string;
  callContext?: CallContextInfo;
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
  const { query, directory, limit, threshold, mode, includeCallContext } =
    input;

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

    vectorStore.close();

    let formattedResults = formatResults(results, absoluteDir);

    // Add call context if requested
    if (includeCallContext && formattedResults.length > 0) {
      // Build call graph for the directory
      const ig = createIgnoreFilter(absoluteDir);
      const files = collectFiles(absoluteDir, ig, absoluteDir);
      const fileContents = files.map((f) => ({
        path: f,
        content: fs.readFileSync(f, "utf-8"),
      }));

      const callGraph = await buildCallGraph(fileContents);

      // Add call context to each result that has a symbol name
      formattedResults = formattedResults.map((result) => {
        if (!result.symbolName) {
          return result;
        }

        const fullPath = path.join(absoluteDir, result.filePath);
        const context = getCallContext(callGraph, fullPath, result.symbolName);

        if (context) {
          return {
            ...result,
            callContext: {
              callers: context.callers.map((c) => c.name),
              callees: context.callees.map((c) => c.name),
            },
          };
        }

        return result;
      });
    }

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

      let callInfo = "";
      if (r.callContext) {
        const callers =
          r.callContext.callers.length > 0
            ? `Called by: ${r.callContext.callers.slice(0, 3).join(", ")}${r.callContext.callers.length > 3 ? "..." : ""}`
            : "";
        const callees =
          r.callContext.callees.length > 0
            ? `Calls: ${r.callContext.callees.slice(0, 3).join(", ")}${r.callContext.callees.length > 3 ? "..." : ""}`
            : "";
        if (callers || callees) {
          callInfo = `\n   ${[callers, callees].filter(Boolean).join(" | ")}`;
        }
      }

      return `${String(i + 1)}. [${r.language}] ${location}${symbol}\n   ${preview}...${callInfo}`;
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
    "Search code semantically using natural language queries. USE THIS to find code by concept/meaning (e.g., 'authentication logic', 'error handling'). Requires index_codebase first. Returns relevant code chunks with file locations, function names, and call relationships (who calls what).",
  schema: searchCodeSchema,
  execute,
};
