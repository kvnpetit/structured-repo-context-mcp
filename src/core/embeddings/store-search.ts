import type * as lancedb from "@lancedb/lancedb";
import * as path from "node:path";

import type { SearchResult } from "@core/embeddings/types";
import { logger } from "@utils";

import type {
  AdjacentChunkResult,
  AdjacentChunks,
  HybridSearchOptions,
  LanceDBRow,
} from "./store-types";
import { escapeRegExp, normalizeFilePath } from "./store-utils";

const MAX_ADJACENT_FILE_ROWS = 5_000;
const MAX_ADJACENT_RESULTS = 6;

function toSearchResult(row: LanceDBRow, score: number): SearchResult {
  return {
    chunk: {
      id: row.id,
      content: row.content,
      filePath: row.filePath,
      language: row.language,
      startLine: row.startLine,
      endLine: row.endLine,
      symbolName: row.symbolName || undefined,
      symbolType: row.symbolType || undefined,
    },
    score,
  };
}

function rrfFusion(
  vectorResults: SearchResult[],
  ftsResults: SearchResult[],
  k = 60,
  vectorWeight = 0.5,
): SearchResult[] {
  const scores = new Map<string, { score: number; result: SearchResult }>();
  const boundedVectorWeight = Number.isFinite(vectorWeight)
    ? Math.min(1, Math.max(0, vectorWeight))
    : 0.5;
  const addResults = (results: SearchResult[], weight: number): void => {
    results.forEach((result, index) => {
      const score = weight / (k + index + 1);
      const existing = scores.get(result.chunk.id);
      if (existing === undefined) {
        scores.set(result.chunk.id, { score, result });
      } else {
        existing.score += score;
      }
    });
  };
  addResults(vectorResults, boundedVectorWeight);
  addResults(ftsResults, 1 - boundedVectorWeight);
  return [...scores.values()]
    .sort((left, right) => right.score - left.score)
    .map(({ score, result }) => ({ ...result, score }));
}

export async function searchVector(
  table: lancedb.Table | null,
  queryVector: number[],
  limit: number,
): Promise<SearchResult[]> {
  if (table === null) {
    return [];
  }
  const rows = (await table
    .vectorSearch(queryVector)
    .limit(limit)
    .toArray()) as LanceDBRow[];
  return rows.map((row) => toSearchResult(row, row._distance ?? 0));
}

export async function searchLexical(
  table: lancedb.Table | null,
  queryText: string,
  limit: number,
): Promise<SearchResult[]> {
  if (table === null) {
    return [];
  }
  const terms =
    queryText
      .toLowerCase()
      .match(/[a-z0-9_$]+/giu)
      ?.filter((term, index, all) => all.indexOf(term) === index) ?? [];
  if (terms.length === 0) {
    return [];
  }

  const rows = (await table.query().toArray()) as LanceDBRow[];
  return rows
    .map((row) => {
      const content = row.content.toLowerCase();
      const symbol = `${row.symbolName} ${row.symbolType}`.toLowerCase();
      const pathText = row.filePath.toLowerCase();
      let score = 0;
      for (const term of terms) {
        score += (
          content.match(new RegExp(`\\b${escapeRegExp(term)}\\b`, "gu")) ?? []
        ).length;
        score +=
          3 *
          (symbol.match(new RegExp(`\\b${escapeRegExp(term)}\\b`, "gu")) ?? [])
            .length;
        score +=
          0.5 *
          (pathText.match(new RegExp(escapeRegExp(term), "gu")) ?? []).length;
      }
      if (content.includes(queryText.toLowerCase())) {
        score += 2;
      }
      return { row, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ row, score }) => toSearchResult(row, score));
}

export async function searchFts(
  table: lancedb.Table | null,
  ensureFtsIndex: () => Promise<void>,
  queryText: string,
  limit: number,
): Promise<SearchResult[]> {
  if (table === null) {
    return searchLexical(table, queryText, limit);
  }
  await ensureFtsIndex();
  try {
    const rows = (await table
      .query()
      .nearestToText(queryText)
      .limit(limit)
      .toArray()) as LanceDBRow[];
    return rows.map((row, index) => toSearchResult(row, 1 / (index + 1)));
  } catch (error) {
    logger.warn(
      `FTS search failed, falling back to lexical search: ${error instanceof Error ? error.message : String(error)}`,
    );
    return searchLexical(table, queryText, limit);
  }
}

export async function searchHybrid(
  table: lancedb.Table | null,
  ensureFtsIndex: () => Promise<void>,
  queryVector: number[],
  queryText: string,
  limit: number,
  options: HybridSearchOptions,
): Promise<SearchResult[]> {
  const { mode = "hybrid", rrfK = 60, vectorWeight = 0.5 } = options;
  if (table === null) {
    return [];
  }
  if (mode === "vector") {
    return searchVector(table, queryVector, limit);
  }
  if (mode === "fts") {
    return searchFts(table, ensureFtsIndex, queryText, limit);
  }
  const [vectorResults, ftsResults] = await Promise.all([
    searchVector(table, queryVector, limit * 2),
    searchFts(table, ensureFtsIndex, queryText, limit * 2),
  ]);
  return rrfFusion(vectorResults, ftsResults, rrfK, vectorWeight).slice(
    0,
    limit,
  );
}

export async function getAdjacentChunks(
  table: lancedb.Table | null,
  filePath: string,
  chunkId: string,
  window: number,
): Promise<AdjacentChunks> {
  const boundedWindow = Math.min(3, Math.max(0, Math.trunc(window)));
  if (table === null || boundedWindow === 0) {
    return { neighbors: [], candidatesConsidered: 0, truncated: false };
  }

  const resolvedFilePath = path.resolve(filePath);
  const normalizedSqlPath = resolvedFilePath
    .replace(/\\/gu, "/")
    .replace(/'/gu, "''");
  const projection = [
    "id",
    "content",
    "filePath",
    "language",
    "startLine",
    "endLine",
    "symbolName",
    "symbolType",
  ];
  let rows = (await table
    .query()
    .select(projection)
    .where(
      `lower(replace("filePath", chr(92), '/')) = lower('${normalizedSqlPath}')`,
    )
    .limit(MAX_ADJACENT_FILE_ROWS + 1)
    .toArray()) as LanceDBRow[];
  if (rows.length === 0) {
    rows = (await table
      .query()
      .select(projection)
      .limit(MAX_ADJACENT_FILE_ROWS + 1)
      .toArray()) as LanceDBRow[];
  }

  const sameFileRows = rows
    .filter(
      (row) => normalizeFilePath(row.filePath) === normalizeFilePath(filePath),
    )
    .sort(
      (left, right) =>
        left.startLine - right.startLine ||
        left.endLine - right.endLine ||
        left.id.localeCompare(right.id),
    );
  const truncated = rows.length > MAX_ADJACENT_FILE_ROWS;
  if (sameFileRows.length === 0) {
    return { neighbors: [], candidatesConsidered: 0, truncated };
  }
  const anchorIndex = sameFileRows.findIndex((row) => row.id === chunkId);
  if (anchorIndex < 0) {
    return {
      neighbors: [],
      candidatesConsidered: sameFileRows.length,
      truncated,
    };
  }

  const neighbors: AdjacentChunkResult[] = [];
  for (let distance = 1; distance <= boundedWindow; distance += 1) {
    for (const index of [anchorIndex - distance, anchorIndex + distance]) {
      const row = sameFileRows[index];
      if (row === undefined) {
        continue;
      }
      neighbors.push({ result: toSearchResult(row, 0), distance });
      if (neighbors.length >= MAX_ADJACENT_RESULTS) {
        return {
          neighbors,
          candidatesConsidered: sameFileRows.length,
          truncated,
        };
      }
    }
  }
  return { neighbors, candidatesConsidered: sameFileRows.length, truncated };
}
