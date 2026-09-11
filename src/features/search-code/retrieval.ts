import * as path from "node:path";

import type { SearchMode, SearchResult } from "@core/embeddings";

import type {
  AdjacentChunkStore,
  NeighborExpansion,
  QueryKind,
  SearchCandidate,
  SearchFilters,
} from "./types";
import { splitContentParts } from "./format";

const MAX_NEIGHBOR_SEEDS = 20;
export const MAX_NEIGHBOR_RESULTS = 120;

function queryTerms(query: string): string[] {
  return (
    query
      .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9_$]+/gu)
      ?.filter((term, index, terms) => terms.indexOf(term) === index) ?? []
  );
}

export function classifyQuery(query: string): QueryKind {
  const trimmed = query.trim();
  const terms = queryTerms(trimmed);
  const hasIdentifier =
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/u.test(trimmed) ||
    terms.some((term) => /[_$]/u.test(term) || /[A-Z]/u.test(term));
  if (hasIdentifier && terms.length <= 2) {
    return terms.length === 1 ? "identifier" : "mixed";
  }
  return terms.length >= 2 ? "concept" : hasIdentifier ? "identifier" : "concept";
}

/** Apply a bounded provider-free second pass after vector/FTS retrieval. */
export function rerankResults(
  results: SearchCandidate[],
  query: string,
  mode: "none" | "lexical" | "code",
): SearchCandidate[] {
  if (mode === "none" || results.length < 2) {
    return results;
  }

  const terms = queryTerms(query);
  const queryKind = classifyQuery(query);
  if (terms.length === 0) {
    return results;
  }

  return results
    .map((result, index) => {
      const content = result.chunk.content.toLowerCase();
      const symbol =
        `${result.chunk.symbolName ?? ""} ${result.chunk.symbolType ?? ""}`.toLowerCase();
      const filePath = result.chunk.filePath.toLowerCase();
      let lexicalScore = 0;
      for (const term of terms) {
        if (symbol.includes(term)) {
          lexicalScore += queryKind === "concept" ? 1.5 : 3;
        }
        if (content.includes(term)) {
          lexicalScore += 1;
        }
        if (filePath.includes(term)) {
          lexicalScore += 0.5;
        }
      }

      if (mode === "code") {
        const symbolName = result.chunk.symbolName?.toLowerCase() ?? "";
        const signature = splitContentParts(result.chunk.content).signature?.toLowerCase();
        const symbolMatches = terms.filter((term) => queryTerms(symbolName).includes(term)).length;
        if (symbolName === query.trim().toLowerCase()) {
          lexicalScore += 8;
        }
        lexicalScore += symbolMatches * 3;
        if (signature?.includes(query.trim().toLowerCase()) === true) {
          lexicalScore += 2;
        }
      }

      const lexicalDenominator =
        mode === "code" ? Math.max(terms.length * 8, 1) : Math.max(terms.length * 4.5, 1);
      const lexicalSignal = Math.min(1, lexicalScore / lexicalDenominator);
      const rankSignal = 1 / (index + 1);
      return {
        result,
        score:
          mode === "code"
            ? rankSignal * 0.4 + lexicalSignal * 0.6
            : rankSignal * 0.65 + lexicalSignal * 0.35,
      };
    })
    .sort((left, right) => right.score - left.score)
    .map(({ result, score }) => ({ ...result, score }));
}

export function deduplicateResults(results: SearchCandidate[]): {
  results: SearchCandidate[];
  removed: number;
} {
  const seen = new Set<string>();
  const deduplicated = results.filter((result) => {
    const key = `${result.chunk.filePath}:${String(result.chunk.startLine)}:${result.chunk.symbolName ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return {
    results: deduplicated,
    removed: results.length - deduplicated.length,
  };
}

export function confidenceForResult(
  result: SearchCandidate,
  index: number,
  results: readonly SearchCandidate[],
  query: string,
): number {
  const kind = classifyQuery(query);
  const terms = queryTerms(query);
  const lowerQuery = query.toLowerCase();
  const lowerContent = result.chunk.content.toLowerCase();
  const lowerSymbol =
    `${result.chunk.symbolName ?? ""} ${result.chunk.symbolType ?? ""}`.toLowerCase();
  let confidence = 0.25 + Math.min(0.25, 0.2 / (index + 1));
  if (lowerSymbol.includes(lowerQuery)) {
    confidence += kind === "concept" ? 0.16 : 0.35;
  }
  if (lowerContent.includes(lowerQuery)) {
    confidence += 0.16;
  }
  const matchedTerms = terms.filter((term) => lowerContent.includes(term)).length;
  confidence += terms.length === 0 ? 0 : (matchedTerms / terms.length) * 0.18;
  const nextScore = results[index + 1]?.score;
  if (nextScore !== undefined && result.score > nextScore) {
    confidence += Math.min(
      0.12,
      Math.abs(result.score - nextScore) / Math.max(Math.abs(result.score), 1),
    );
  }
  if (result.neighborDistance !== undefined) {
    confidence *= 0.82 ** result.neighborDistance;
  }
  return Number(Math.min(1, Math.max(0, confidence)).toFixed(4));
}

function adjacentScore(
  primaryScore: number,
  mode: SearchMode,
  rerank: "none" | "lexical" | "code",
  distance: number,
): number {
  if (mode === "vector" && rerank === "none") {
    return primaryScore + distance * 0.05;
  }
  return primaryScore * 0.82 ** distance;
}

export async function expandNeighborResults(
  vectorStore: AdjacentChunkStore,
  primaryResults: readonly SearchCandidate[],
  root: string,
  filters: SearchFilters,
  neighborWindow: number,
  mode: SearchMode,
  rerank: "none" | "lexical" | "code",
): Promise<NeighborExpansion> {
  const getAdjacentChunks = vectorStore.getAdjacentChunks;
  if (neighborWindow === 0 || typeof getAdjacentChunks !== "function") {
    return {
      results: [...primaryResults],
      candidatesConsidered: 0,
      added: 0,
      duplicatesRemoved: 0,
      truncated: false,
    };
  }

  const seeds = primaryResults
    .filter((result) => result.isNeighbor !== true)
    .slice(0, MAX_NEIGHBOR_SEEDS);
  const expansions = await Promise.all(
    seeds.map(async (primary) => {
      try {
        return await getAdjacentChunks.call(
          vectorStore,
          primary.chunk.filePath,
          primary.chunk.id,
          neighborWindow,
        );
      } catch {
        return {
          neighbors: [],
          candidatesConsidered: 0,
          truncated: true,
        };
      }
    }),
  );

  const neighbors: SearchCandidate[] = [];
  let candidatesConsidered = 0;
  let truncated = primaryResults.length > seeds.length;
  for (const [index, expansion] of expansions.entries()) {
    candidatesConsidered += expansion.candidatesConsidered;
    truncated ||= expansion.truncated;
    const primary = seeds[index];
    if (primary === undefined) {
      continue;
    }
    for (const adjacent of expansion.neighbors) {
      if (neighbors.length >= MAX_NEIGHBOR_RESULTS) {
        truncated = true;
        break;
      }
      if (
        !matchesSearchFilters(adjacent.result, root, filters) ||
        adjacent.result.chunk.id === primary.chunk.id
      ) {
        continue;
      }
      neighbors.push({
        ...adjacent.result,
        score: adjacentScore(primary.score, mode, rerank, adjacent.distance),
        isNeighbor: true,
        neighborOf: primary.chunk.id,
        neighborDistance: adjacent.distance,
      });
    }
    if (neighbors.length >= MAX_NEIGHBOR_RESULTS) {
      break;
    }
  }

  const combined = deduplicateResults([...primaryResults, ...neighbors]);
  return {
    results: combined.results,
    candidatesConsidered,
    added: Math.max(0, combined.results.length - primaryResults.length),
    duplicatesRemoved: combined.removed,
    truncated,
  };
}

function normalizeProjectPath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function isTestPath(filePath: string): boolean {
  const normalized = normalizeProjectPath(filePath).toLowerCase();
  return (
    /(?:^|\/)(?:test|tests|__tests__|spec|specs)(?:\/|$)/u.test(normalized) ||
    /(?:\.test|\.spec|_test|_spec)(?:\.[^/]+)+$/u.test(normalized)
  );
}

export function hasSearchFilters(filters: SearchFilters): boolean {
  return (
    filters.language !== undefined ||
    filters.path_prefix !== undefined ||
    filters.symbol_type !== undefined ||
    !filters.include_tests
  );
}

export function matchesSearchFilters(
  result: SearchResult,
  root: string,
  filters: SearchFilters,
): boolean {
  if (
    filters.language !== undefined &&
    result.chunk.language.toLowerCase() !== filters.language.toLowerCase()
  ) {
    return false;
  }
  if (
    filters.symbol_type !== undefined &&
    result.chunk.symbolType?.toLowerCase() !== filters.symbol_type.toLowerCase()
  ) {
    return false;
  }
  const relativePath = normalizeProjectPath(path.relative(root, result.chunk.filePath));
  if (
    filters.path_prefix !== undefined &&
    !(
      relativePath === normalizeProjectPath(filters.path_prefix) ||
      relativePath.startsWith(`${normalizeProjectPath(filters.path_prefix).replace(/\/$/u, "")}/`)
    )
  ) {
    return false;
  }
  return filters.include_tests || !isTestPath(relativePath);
}
