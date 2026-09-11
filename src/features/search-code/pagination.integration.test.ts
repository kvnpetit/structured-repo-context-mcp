import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { EMBEDDING_CONFIG } from "@config";
import type * as ConfigModule from "@config";
import { createLexicalEmbeddingClient } from "@core/embeddings/client";
import { createVectorStore } from "@core/embeddings/store";
import type { EmbeddedChunk, SearchMode } from "@core/embeddings";
import { execute, type SearchCodeInput } from "./index";
import type { SearchOutput } from "./types";

vi.mock("@config", async (importOriginal) => {
  const original = await importOriginal<typeof ConfigModule>();
  return {
    ...original,
    EMBEDDING_CONFIG: {
      ...original.EMBEDDING_CONFIG,
      embeddingProvider: "lexical",
      embeddingDimensions: 64,
    },
  };
});

describe("native LanceDB search pagination", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-search-pages-"));
    vi.stubEnv("SRC_ALLOWED_ROOTS", directory);
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function seed(count: number, duplicates = false, createFts = true): Promise<void> {
    const client = createLexicalEmbeddingClient(64);
    const chunks: EmbeddedChunk[] = [];
    for (let index = 0; index < count; index++) {
      const name = `worker${String(index).padStart(4, "0")}`;
      const folder = index % 5 === 0 ? "tests" : "src";
      const content = `export function ${name}() { return "pagination shared worker ${String(index)}"; }`;
      const chunk: EmbeddedChunk = {
        id: name,
        filePath: path.join(directory, folder, `${name}.ts`),
        content,
        language: "typescript",
        symbolName: name,
        symbolType: "function",
        startLine: 1,
        endLine: 1,
        vector: await client.embed(content),
      };
      chunks.push(chunk);
      if (duplicates && index % 4 === 0) {
        chunks.push({ ...chunk, id: `${name}-duplicate` });
      }
    }
    const store = createVectorStore(directory, EMBEDDING_CONFIG);
    try {
      await store.connect();
      await store.addChunks(chunks);
      if (createFts) {
        await store.createFtsIndex();
      }
    } finally {
      store.close();
    }
  }

  async function search(input: Partial<SearchCodeInput> = {}): Promise<SearchOutput> {
    const response = await execute({
      directory,
      query: "pagination shared worker",
      includeCallContext: false,
      ...input,
    });
    expect(response.success, response.error).toBe(true);
    return response.data as SearchOutput;
  }

  test("default first page exposes the cursor needed to reach every hit", async () => {
    await seed(27);
    const first = await search();
    expect(first.resultsCount).toBe(10);
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).toBeTypeOf("string");

    const second = await search({ cursor: first.next_cursor });
    const third = await search({ cursor: second.next_cursor });
    expect(second.resultsCount).toBe(10);
    expect(third.resultsCount).toBe(7);
    expect(third.truncated).toBe(false);
    expect(third.next_cursor).toBeUndefined();
    expect(
      new Set(
        [...first.results, ...second.results, ...third.results].map((result) => result.filePath),
      ).size,
    ).toBe(27);
  });

  test("the first FTS index creation does not invalidate its own next-page cursor", async () => {
    await seed(17, false, false);
    let page = await search({ mode: "fts", limit: 5 });
    const results = [...page.results];
    while (page.next_cursor !== undefined) {
      page = await search({ mode: "fts", limit: 5, cursor: page.next_cursor });
      results.push(...page.results);
      expect(results.length).toBeLessThanOrEqual(17);
    }
    expect(results).toHaveLength(17);
    expect(new Set(results.map((result) => result.filePath)).size).toBe(17);
  });

  test.each(["delete", "empty replacement"])(
    "rejects a stale cursor after %s commits without a metadata change",
    async (mutation) => {
      await seed(15);
      const first = await search({ mode: "fts", limit: 5 });
      const removed = first.results[0];
      expect(first.next_cursor).toBeTypeOf("string");
      if (removed === undefined) {
        throw new Error("Missing first search result");
      }
      const store = createVectorStore(directory, EMBEDDING_CONFIG);
      try {
        await store.connect();
        const metadata = store.getMetadata();
        const revision = await store.getRevision();
        const filePath = path.resolve(directory, removed.filePath);
        if (mutation === "delete") {
          await store.deleteByFilePath(filePath);
        } else {
          await store.replaceFileChunks(filePath, []);
        }
        expect(store.getMetadata()).toEqual(metadata);
        expect(await store.getRevision()).not.toBe(revision);
      } finally {
        store.close();
      }
      const response = await execute({
        directory,
        query: "pagination shared worker",
        mode: "fts",
        limit: 5,
        includeCallContext: false,
        cursor: first.next_cursor,
      });
      expect(response.success).toBe(false);
      expect(response.error).toContain("does not match this query");
    },
  );

  test.each<SearchMode>(["fts", "hybrid", "vector"])(
    "%s keeps ordering, confidence, filters and dedup stable across page sizes",
    async (mode) => {
      await seed(37, true);
      const options = {
        mode,
        rerank: "code" as const,
        include_tests: false,
        path_prefix: "src",
        language: "typescript",
        symbol_type: "function",
        min_confidence: 0.3,
      };
      const complete = await search({ ...options, limit: 100 });
      expect(complete.resultsCount).toBe(29);
      expect(complete.retrieval.duplicates_removed).toBeGreaterThan(0);
      let page = await search({ ...options, limit: 3 });
      const paged = [...page.results];
      while (page.next_cursor !== undefined) {
        page = await search({ ...options, limit: 7, cursor: page.next_cursor });
        paged.push(...page.results);
        expect(paged.length).toBeLessThanOrEqual(complete.resultsCount);
      }
      expect(page.truncated).toBe(false);
      expect(paged).toEqual(complete.results);
      expect(new Set(paged.map((result) => result.filePath)).size).toBe(29);
    },
  );

  test("hard cap remains visible after the last available page and after filtering", async () => {
    await seed(503);
    let page = await search({ mode: "fts", limit: 100 });
    let total = page.resultsCount;
    while (page.next_cursor !== undefined) {
      page = await search({
        mode: "fts",
        limit: 100,
        cursor: page.next_cursor,
      });
      total += page.resultsCount;
      expect(total).toBeLessThanOrEqual(500);
    }
    expect(total).toBe(500);
    expect(page.resultsCount).toBe(100);
    expect(page.truncated).toBe(true);
    expect(page.next_cursor).toBeUndefined();

    const excluded = await execute({
      directory,
      query: "pagination shared worker",
      mode: "fts",
      language: "python",
      includeCallContext: false,
    });
    expect(excluded.success).toBe(true);
    expect(excluded.data).toMatchObject({
      resultsCount: 0,
      truncated: true,
    });
    expect((excluded.data as SearchOutput).next_cursor).toBeUndefined();
    expect(excluded.message).toContain("first 500 retrieval candidates");
  });

  test("rejects cursors after a threshold or indexed revision changes", async () => {
    await seed(25);
    const first = await search({ mode: "vector", threshold: 2, limit: 5 });
    expect(first.next_cursor).toBeTypeOf("string");
    const changedThreshold = await execute({
      directory,
      query: "pagination shared worker",
      mode: "vector",
      threshold: 1,
      cursor: first.next_cursor,
      includeCallContext: false,
    });
    expect(changedThreshold.success).toBe(false);
    expect(changedThreshold.error).toContain("does not match this query");

    const store = createVectorStore(directory, EMBEDDING_CONFIG);
    try {
      await store.connect();
      store.setSourceFingerprint("a".repeat(64));
    } finally {
      store.close();
    }
    const changedIndex = await execute({
      directory,
      query: "pagination shared worker",
      mode: "vector",
      threshold: 2,
      cursor: first.next_cursor,
      includeCallContext: false,
    });
    expect(changedIndex.success).toBe(false);
    expect(changedIndex.error).toContain("does not match this query");
  });
});
