/**
 * Re-ranking module for improving search result relevance
 *
 * Uses Ollama LLM to score query-document pairs and reorder results
 * based on semantic relevance rather than just vector similarity.
 */

import type { SearchResult } from "@core/embeddings/types";
import { logger } from "@utils";

/**
 * Re-ranking options
 */
export interface RerankerOptions {
  /** Ollama base URL */
  ollamaBaseUrl: string;
  /** Model to use for re-ranking (default: llama3.2) */
  model?: string;
  /** Maximum number of results to re-rank (default: 20) */
  maxResults?: number;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Re-ranked result with LLM score
 */
export interface RerankedResult extends SearchResult {
  /** Original search score */
  originalScore: number;
  /** LLM relevance score (0-10) */
  rerankScore: number;
}

/**
 * Parse LLM response to extract relevance score
 */
function parseScore(response: string): number {
  // Try to extract a number from the response
  const match = /\b(\d+(?:\.\d+)?)\b/.exec(response);
  if (match?.[1]) {
    const score = parseFloat(match[1]);
    // Normalize to 0-10 range
    if (score >= 0 && score <= 10) {
      return score;
    }
    if (score > 10 && score <= 100) {
      return score / 10;
    }
  }
  // Default to middle score if parsing fails
  return 5;
}

/**
 * Score a single query-document pair using Ollama
 */
async function scoreResult(
  query: string,
  content: string,
  options: RerankerOptions,
): Promise<number> {
  const model = options.model ?? "llama3.2";
  const timeout = options.timeout ?? 30000;

  const prompt = `Rate the relevance of the following code snippet to the search query on a scale of 0-10.
0 = completely irrelevant
5 = somewhat relevant
10 = highly relevant and directly answers the query

Query: "${query}"

Code:
\`\`\`
${content.slice(0, 1000)}
\`\`\`

Respond with ONLY a number between 0 and 10.`;

  try {
    const response = await fetch(`${options.ollamaBaseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: 0,
          num_predict: 10, // We only need a short response
        },
      }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      logger.warn(`Re-ranking request failed: ${response.statusText}`);
      return 5; // Default score
    }

    const data = (await response.json()) as { response?: string };
    return parseScore(data.response ?? "5");
  } catch (error) {
    logger.warn(
      `Re-ranking error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 5; // Default score on error
  }
}

/**
 * Re-rank search results using LLM scoring
 *
 * Takes initial search results and re-scores them based on
 * semantic relevance to the query using an LLM.
 */
export async function rerank(
  query: string,
  results: SearchResult[],
  options: RerankerOptions,
): Promise<RerankedResult[]> {
  const maxResults = options.maxResults ?? 20;

  // Limit results to re-rank for performance
  const toRerank = results.slice(0, maxResults);

  if (toRerank.length === 0) {
    return [];
  }

  logger.debug(`Re-ranking ${String(toRerank.length)} results for: ${query}`);

  // Score all results in parallel (with some concurrency limit)
  const batchSize = 5;
  const rerankedResults: RerankedResult[] = [];

  for (let i = 0; i < toRerank.length; i += batchSize) {
    const batch = toRerank.slice(i, i + batchSize);
    const scores = await Promise.all(
      batch.map(async (result) =>
        scoreResult(query, result.chunk.content, options),
      ),
    );

    for (let j = 0; j < batch.length; j++) {
      const result = batch[j];
      const score = scores[j];
      if (result !== undefined && score !== undefined) {
        rerankedResults.push({
          ...result,
          originalScore: result.score,
          rerankScore: score,
          score: score, // Use rerank score as the new score
        });
      }
    }
  }

  // Sort by rerank score (higher is better)
  rerankedResults.sort((a, b) => b.rerankScore - a.rerankScore);

  logger.debug(
    `Re-ranking complete, top score: ${String(rerankedResults[0]?.rerankScore ?? 0)}`,
  );

  return rerankedResults;
}

/**
 * Create a reranker function with preset options
 */
export function createReranker(
  options: RerankerOptions,
): (query: string, results: SearchResult[]) => Promise<RerankedResult[]> {
  return async (query: string, results: SearchResult[]) =>
    rerank(query, results, options);
}
