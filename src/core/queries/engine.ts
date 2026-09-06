import {
  type Language,
  Query,
  type QueryMatch as TSQueryMatch,
  type Tree,
} from "web-tree-sitter";

import type { QueryCapture, QueryMatch } from "@core/ast/types";
import { registerLanguageCacheInvalidator, toASTNode } from "@core/parser";
import { registerCache } from "@core/utils";

import {
  hasOfficialTags,
  loadHighlightsQuery,
  loadLocalsQuery,
  loadTagsQuery,
  type SCMQueryType,
} from "./loader";
import {
  getAvailablePresets as getAvailablePresetsBase,
  type QueryPreset,
} from "./patterns";

const QUERY_CAPTURE_MAX_DEPTH = 1;
const MAX_COMPILED_QUERIES = 128;
const compiledQueries = new Map<Language, Map<string, Query>>();
let compiledQueryCount = 0;

export interface QueryResult {
  matches: QueryMatch[];
  count: number;
  query: string;
  language: string;
  source: "official" | "preset";
}

export interface QueryOptions {
  maxMatches?: number;
  startIndex?: number;
  endIndex?: number;
  preferOfficial?: boolean;
  /** Cache this trusted query's compiled WASM representation (bounded). */
  cache?: boolean;
}

export function getCompiledQueryCacheStats(): {
  queries: number;
  languages: number;
  limit: number;
} {
  return {
    queries: compiledQueryCount,
    languages: compiledQueries.size,
    limit: MAX_COMPILED_QUERIES,
  };
}

export function clearCompiledQueryCache(): void {
  for (const queries of compiledQueries.values()) {
    for (const query of queries.values()) {
      query.delete();
    }
  }
  compiledQueries.clear();
  compiledQueryCount = 0;
}

registerLanguageCacheInvalidator(clearCompiledQueryCache);
registerCache("queries:compiled", clearCompiledQueryCache);

export function getAvailablePresets(language: string): QueryPreset[] {
  return getAvailablePresetsBase(language, hasOfficialTags(language));
}

function compiledQuery(
  language: Language,
  queryString: string,
  cache: boolean,
): { query: Query; owned: boolean } {
  if (cache) {
    const cached = compiledQueries.get(language)?.get(queryString);
    if (cached !== undefined) {
      return { query: cached, owned: false };
    }
  }
  const query = new Query(language, queryString);
  if (!cache || compiledQueryCount >= MAX_COMPILED_QUERIES) {
    return { query, owned: true };
  }
  const languageQueries =
    compiledQueries.get(language) ?? new Map<string, Query>();
  languageQueries.set(queryString, query);
  compiledQueries.set(language, languageQueries);
  compiledQueryCount += 1;
  return { query, owned: false };
}

export function executeQuery(
  tree: Tree,
  languageInstance: Language,
  queryString: string,
  language: string,
  options: QueryOptions = {},
): QueryResult {
  const { maxMatches, startIndex, endIndex, cache = false } = options;
  let query: Query;
  let owned: boolean;
  try {
    ({ query, owned } = compiledQuery(languageInstance, queryString, cache));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid query: ${message}`);
  }

  try {
    const queryMatches: TSQueryMatch[] = query.matches(tree.rootNode, {
      startIndex,
      endIndex,
    });
    const matches: QueryMatch[] = [];
    for (const match of queryMatches) {
      if (maxMatches !== undefined && matches.length >= maxMatches) {
        break;
      }
      const captures: QueryCapture[] = match.captures.map((capture) => ({
        name: capture.name,
        node: toASTNode(capture.node, QUERY_CAPTURE_MAX_DEPTH),
      }));
      matches.push({ pattern: match.patternIndex, captures });
    }
    return {
      matches,
      count: matches.length,
      query: queryString,
      language,
      source: "preset",
    };
  } finally {
    if (owned) {
      query.delete();
    }
  }
}

export function executeOfficialQuery(
  tree: Tree,
  languageInstance: Language,
  language: string,
  queryType: SCMQueryType,
  options: QueryOptions = {},
): QueryResult | undefined {
  let queryString: string | undefined;
  switch (queryType) {
    case "tags":
      queryString = loadTagsQuery(language);
      break;
    case "highlights":
      queryString = loadHighlightsQuery(language);
      break;
    case "locals":
      queryString = loadLocalsQuery(language);
      break;
    case "injections":
    case "indents":
    case "folds":
      return undefined;
  }
  if (!queryString) {
    return undefined;
  }
  try {
    return {
      ...executeQuery(tree, languageInstance, queryString, language, {
        ...options,
        cache: true,
      }),
      source: "official",
    };
  } catch {
    return undefined;
  }
}

export function executeTagsQuery(
  tree: Tree,
  languageInstance: Language,
  language: string,
  options: QueryOptions = {},
): QueryResult | undefined {
  return executeOfficialQuery(
    tree,
    languageInstance,
    language,
    "tags",
    options,
  );
}
