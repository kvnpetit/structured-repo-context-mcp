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
 * - deterministic lexical re-ranking for improved symbol/name relevance
 * - Call context to show callers/callees for each result
 */

import * as path from "node:path";
import type { Feature, FeatureResult } from "@features/types";
import { EMBEDDING_CONFIG } from "@config";
import {
  createOllamaClient,
  createLexicalEmbeddingClient,
  createVectorStore,
  buildCallGraph,
  getCallContext,
  type IndexMetadata,
} from "@core/embeddings";
import { collectFiles, createIgnoreFilter } from "@core/files";
import {
  createPaginationCursor,
  createPaginationScope,
  decodePaginationCursor,
} from "@core/pagination";
import { readSecureTextFile, resolveSecureDirectory, safeErrorMessage } from "@core/security";
import { searchCodeOutputSchema, searchCodeSchema, type SearchCodeInput } from "./schema";
import {
  classifyQuery,
  confidenceForResult,
  deduplicateResults,
  expandNeighborResults,
  matchesSearchFilters,
  rerankResults,
} from "./retrieval";
import { formatResults } from "./format";
import type { SearchCandidate, SearchOutput } from "./types";

const MAX_SEARCH_CANDIDATES = 500;

export {
  searchCodeOutputSchema,
  searchCodeSchema,
  type SearchCodeInput,
} from "./schema";

/**
 * Execute the search_code feature
 */
export async function execute(input: SearchCodeInput): Promise<FeatureResult> {
  const parsedInput = searchCodeSchema.parse(input);
  const {
    query,
    directory,
    limit,
    cursor,
    min_confidence,
    threshold,
    mode,
    vectorWeight,
    includeCallContext,
    rerank,
    language,
    path_prefix,
    symbol_type,
    include_tests,
    redact_secrets,
    max_content_bytes,
    neighbor_window,
  } = parsedInput;

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

  try {
    // FTS is a true no-model path. Vector and hybrid modes use the configured
    // provider (Ollama by default, or the deterministic local lexical provider).
    const effectiveMode = mode === "fts" ? "fts" : mode;
    if (effectiveMode !== "fts") {
      const health = await embeddingClient.healthCheck();
      if (!health.ok) {
        return {
          success: false,
          error:
            health.error ??
            (EMBEDDING_CONFIG.embeddingProvider === "lexical"
              ? "Embedding provider is not available"
              : "Ollama is not available"),
        };
      }
    }

    // Connect to vector store
    await vectorStore.connect();
    vectorStore.assertMetadataCompatible();

    const getMetadata = (
      vectorStore as unknown as {
        getMetadata?: () => IndexMetadata | undefined;
      }
    ).getMetadata;
    const indexMetadata =
      typeof getMetadata === "function" ? getMetadata.call(vectorStore) : undefined;
    // Generate query embedding
    const queryVector = effectiveMode === "fts" ? [] : await embeddingClient.embed(query);

    // Search for similar chunks using hybrid search (vector + BM25 + RRF)
    const filters = {
      ...(language === undefined ? {} : { language }),
      ...(path_prefix === undefined ? {} : { path_prefix }),
      ...(symbol_type === undefined ? {} : { symbol_type }),
      include_tests,
    };
    // Rank the same bounded pool on every page. Growing the pool with the
    // offset or page size changes reranking/confidence and can skip results.
    // One extra candidate detects exhaustion without an unbounded query.
    let results: SearchCandidate[] = await vectorStore.searchHybrid(
      queryVector,
      query,
      MAX_SEARCH_CANDIDATES + 1,
      {
        mode: effectiveMode,
        vectorWeight,
      },
    );
    // FTS may create its persisted index on the first query. Bind the cursor
    // afterwards, to the actual table snapshot rather than the metadata file,
    // which can lag a data commit or remain unchanged after a deletion.
    const getRevision = (
      vectorStore as unknown as {
        getRevision?: () => Promise<number | undefined>;
      }
    ).getRevision;
    const tableRevision = await getRevision?.call(vectorStore);
    const paginationScope = createPaginationScope({
      directory: absoluteDir,
      query,
      mode,
      vectorWeight,
      rerank,
      threshold: threshold ?? null,
      language: language ?? null,
      path_prefix: path_prefix ?? null,
      symbol_type: symbol_type ?? null,
      include_tests,
      min_confidence,
      max_content_bytes,
      neighbor_window,
      index_revision: indexMetadata ?? null,
      table_revision: tableRevision ?? null,
    });
    const cursorResult = decodePaginationCursor(cursor, paginationScope);
    if (!cursorResult.ok) {
      vectorStore.close();
      return { success: false, error: cursorResult.error };
    }
    const cursorOffset = cursorResult.offset;
    const candidatesTruncated = results.length > MAX_SEARCH_CANDIDATES;
    results = results.slice(0, MAX_SEARCH_CANDIDATES).sort((left, right) => {
      const scoreOrder =
        effectiveMode === "vector" ? left.score - right.score : right.score - left.score;
      return (
        scoreOrder ||
        left.chunk.filePath.localeCompare(right.chunk.filePath) ||
        left.chunk.startLine - right.chunk.startLine ||
        left.chunk.id.localeCompare(right.chunk.id)
      );
    });
    const boundsMessage = candidatesTruncated
      ? " Search is limited to the first 500 retrieval candidates; refine the query or filters for broader coverage."
      : "";

    // Apply threshold filter if specified (only for vector mode where lower = better)
    // For hybrid/fts modes, RRF scores are higher = better, so threshold is ignored
    if (threshold !== undefined && mode === "vector") {
      results = results.filter((r) => r.score <= threshold);
    }

    results = results.filter((result) => matchesSearchFilters(result, absoluteDir, filters));
    const candidatesConsidered = results.length;
    const deduplicated = deduplicateResults(results);
    const expanded = await expandNeighborResults(
      vectorStore,
      deduplicated.results,
      absoluteDir,
      filters,
      neighbor_window,
      effectiveMode,
      rerank,
    );
    results = rerankResults(expanded.results, query, rerank);
    const scoredResults = results.map((result, index, all) => ({
      result,
      confidence: confidenceForResult(result, index, all, query),
    }));
    const confidentResults = scoredResults.filter(({ confidence }) => confidence >= min_confidence);
    const abstained =
      min_confidence > 0 && scoredResults.length > 0 && confidentResults.length === 0;
    const abstentionReason = abstained
      ? `No result reached the requested confidence floor of ${String(min_confidence)}`
      : undefined;
    const pageResults = confidentResults.slice(cursorOffset, cursorOffset + limit);
    const hasNextPage = cursorOffset + pageResults.length < confidentResults.length;
    const truncated = hasNextPage || candidatesTruncated || expanded.truncated;
    const nextCursor = hasNextPage
      ? createPaginationCursor(paginationScope, cursorOffset + pageResults.length)
      : undefined;

    const index = indexMetadata
      ? {
          schema_version: indexMetadata.schemaVersion,
          embedding_provider: indexMetadata.embeddingProvider,
          embedding_model: indexMetadata.embeddingModel,
          embedding_dimensions: indexMetadata.embeddingDimensions,
          updated_at: indexMetadata.updatedAt,
          ...(indexMetadata.sourceFingerprint === undefined
            ? {}
            : { source_fingerprint: indexMetadata.sourceFingerprint }),
        }
      : {};

    vectorStore.close();

    const formatted = formatResults(
      pageResults.map(({ result }) => result),
      absoluteDir,
      redact_secrets,
      pageResults.map(({ confidence }) => confidence),
      max_content_bytes,
    );
    let formattedResults = formatted.results;

    // Add call context if requested
    if (includeCallContext && formattedResults.length > 0) {
      // Build call graph for the directory
      const ig = createIgnoreFilter(absoluteDir);
      const files = collectFiles(absoluteDir, ig, absoluteDir);
      const fileContents = files.flatMap((f) => {
        const readResult = readSecureTextFile(f, absoluteDir);
        return readResult.ok && readResult.content !== undefined
          ? [{ path: f, content: readResult.content }]
          : [];
      });

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
      truncated,
      cursor_offset: cursorOffset,
      ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
      retrieval: {
        query_kind: classifyQuery(query),
        reranker: rerank,
        candidates_considered: candidatesConsidered,
        duplicates_removed: deduplicated.removed + expanded.duplicatesRemoved,
        min_confidence,
        abstained,
        ...(abstentionReason === undefined ? {} : { abstention_reason: abstentionReason }),
        content_limit_bytes: max_content_bytes,
        content_truncated_count: formatted.contentTruncatedCount,
        neighbor_window,
        neighbors_added: expanded.added,
        neighbor_candidates_considered: expanded.candidatesConsidered,
        neighbors_truncated: expanded.truncated,
      },
      filters,
      index,
      source_is_untrusted: true,
      secrets_redacted: formatted.redacted,
      instruction_signals: formatted.instruction_signals,
      results: formattedResults,
    };

    if (formattedResults.length === 0) {
      return {
        success: true,
        message:
          (abstained
            ? (abstentionReason ?? "No sufficiently confident code found")
            : "No matching code found") + boundsMessage,
        data: output,
      };
    }

    // Build text message with results
    const resultLines = formattedResults.map((r, i) => {
      const location = `${r.filePath}:${String(r.startLine)}-${String(r.endLine)}`;
      const symbol = r.symbolName ? ` (${r.symbolType ?? "symbol"}: ${r.symbolName})` : "";
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

    const message = `Found ${String(formattedResults.length)} results for "${query}":\n\n${resultLines.join("\n\n")}${boundsMessage}`;

    return {
      success: true,
      message,
      data: output,
    };
  } catch (err) {
    vectorStore.close();
    const errorMsg = safeErrorMessage(err, "Search operation failed");
    return {
      success: false,
      error: `Search failed: ${errorMsg}`,
    };
  }
}

export const searchCodeFeature: Feature<typeof searchCodeSchema> = {
  name: "search_code",
  description:
    "Search code semantically using natural language queries, hybrid vector/BM25 retrieval, and deterministic identifier reranking. USE THIS to find code by concept/meaning (e.g., 'authentication logic', 'error handling'). Requires index_codebase first. Returns relevant code chunks with file locations, function names, and call relationships (who calls what).",
  schema: searchCodeSchema,
  outputSchema: searchCodeOutputSchema,
  execute,
};
