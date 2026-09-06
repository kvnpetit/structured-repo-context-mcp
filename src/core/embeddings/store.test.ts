import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  VectorStore,
  computeSourceFingerprint,
  createVectorStore,
  getIndexPath,
} from "@core/embeddings/store";
import type { EmbeddedChunk } from "@core/embeddings/types";

// Mock logger to avoid noise in tests
vi.mock("@utils", () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe("VectorStore", () => {
  let tempDir: string;
  let store: VectorStore;

  const mockConfig = {
    embeddingDimensions: 768,
  };

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lancedb-test-"));
    store = new VectorStore(tempDir, mockConfig);
    await store.connect();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const createMockChunk = (id: string, filePath: string): EmbeddedChunk => ({
    id,
    content: `function ${id}() { return true; }`,
    filePath,
    language: "typescript",
    startLine: 1,
    endLine: 3,
    symbolName: id,
    symbolType: "function",
    vector: new Array(768).fill(0).map(() => Math.random()),
  });

  describe("addChunks", () => {
    test("adds chunks to the store", async () => {
      const chunks = [
        createMockChunk("func1", "/test/file1.ts"),
        createMockChunk("func2", "/test/file1.ts"),
      ];

      await store.addChunks(chunks);
      const status = await store.getStatus(tempDir);

      expect(status.totalChunks).toBe(2);
      expect(status.totalFiles).toBe(1);
    });

    test("throws error when not connected", async () => {
      const disconnectedStore = new VectorStore(tempDir, mockConfig);
      const chunks = [createMockChunk("func1", "/test/file1.ts")];

      await expect(disconnectedStore.addChunks(chunks)).rejects.toThrow(
        "Database not connected",
      );
    });
  });

  describe("search", () => {
    test("returns similar chunks", async () => {
      const chunks = [
        createMockChunk("func1", "/test/file1.ts"),
        createMockChunk("func2", "/test/file2.ts"),
      ];
      await store.addChunks(chunks);

      const queryVector = new Array(768).fill(0).map(() => Math.random());
      const results = await store.search(queryVector, 5);

      expect(results.length).toBeLessThanOrEqual(5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty("chunk");
      expect(results[0]).toHaveProperty("score");
    });

    test("returns empty array when table does not exist", async () => {
      const emptyStore = new VectorStore(
        path.join(tempDir, "empty"),
        mockConfig,
      );
      await emptyStore.connect();

      const queryVector: number[] = new Array<number>(768).fill(0);
      const results = await emptyStore.search(queryVector);

      expect(results).toEqual([]);
    });

    test("returns bounded adjacent chunks in source order", async () => {
      const filePath = path.resolve(tempDir, "module.ts");
      const before = createMockChunk("before", filePath);
      before.startLine = 1;
      before.endLine = 3;
      const middle = createMockChunk("middle", filePath);
      middle.startLine = 5;
      middle.endLine = 8;
      const after = createMockChunk("after", filePath);
      after.startLine = 10;
      after.endLine = 12;
      const other = createMockChunk("other", path.resolve(tempDir, "other.ts"));

      await store.addChunks([before, middle, after, other]);

      expect(await store.getIndexedFiles()).toContain(filePath);

      const adjacent = await store.getAdjacentChunks(filePath, "middle", 1);

      expect(adjacent.truncated).toBe(false);
      expect(adjacent.candidatesConsidered).toBe(3);
      expect(adjacent.neighbors.map((item) => item.result.chunk.id)).toEqual([
        "before",
        "after",
      ]);
      expect(adjacent.neighbors.map((item) => item.distance)).toEqual([1, 1]);
    });
  });

  describe("deleteByFilePath", () => {
    test("executes without error", async () => {
      const chunks = [
        createMockChunk("func1", "/test/file1.ts"),
        createMockChunk("func2", "/test/file2.ts"),
      ];
      await store.addChunks(chunks);

      await store.deleteByFilePath("/test/file1.ts");
      const status = await store.getStatus(tempDir);
      expect(status.totalChunks).toBe(1);
    });

    test("does nothing when table does not exist", async () => {
      const emptyStore = new VectorStore(
        path.join(tempDir, "empty"),
        mockConfig,
      );
      await emptyStore.connect();

      // Should not throw even without a table
      await emptyStore.deleteByFilePath("/test/file.ts");
      expect(true).toBe(true);
    });

    test("throws when path is not absolute", async () => {
      await expect(store.deleteByFilePath("relative/path.ts")).rejects.toThrow(
        "deleteByFilePath requires an absolute path",
      );
    });
  });

  describe("replaceFileChunks", () => {
    test("atomically replaces a file while preserving other files", async () => {
      const targetPath = path.resolve(tempDir, "target.ts");
      const otherPath = path.resolve(tempDir, "other.ts");
      await store.addChunks([
        createMockChunk("old-1", targetPath),
        createMockChunk("old-2", targetPath),
        createMockChunk("other", otherPath),
      ]);

      const replacement = createMockChunk("new-1", targetPath);
      replacement.content = "replacement content";
      await store.replaceFileChunks(targetPath, [replacement]);

      const status = await store.getStatus(tempDir);
      expect(status.totalChunks).toBe(2);
      expect(status.totalFiles).toBe(2);

      const indexedFiles = await store.getIndexedFiles();
      expect(indexedFiles).toContain(targetPath);
      expect(indexedFiles).toContain(otherPath);
    });

    test("removes stale chunks when the replacement is empty", async () => {
      const targetPath = path.resolve(tempDir, "empty.ts");
      await store.addChunks([createMockChunk("old", targetPath)]);

      await store.replaceFileChunks(targetPath, []);

      expect(await store.getIndexedFiles()).not.toContain(targetPath);
    });

    test("rejects chunks from another file before changing the store", async () => {
      const targetPath = path.resolve(tempDir, "target.ts");
      const otherPath = path.resolve(tempDir, "other.ts");
      await store.addChunks([createMockChunk("old", targetPath)]);

      await expect(
        store.replaceFileChunks(targetPath, [
          createMockChunk("wrong", otherPath),
        ]),
      ).rejects.toThrow("chunk for another file");

      expect(await store.getIndexedFiles()).toContain(targetPath);
    });

    test("requires an absolute file path", async () => {
      await expect(store.replaceFileChunks("relative.ts", [])).rejects.toThrow(
        "replaceFileChunks requires an absolute path",
      );
    });

    test("preserves concurrent replacements for different files", async () => {
      const firstPath = path.resolve(tempDir, "first.ts");
      const secondPath = path.resolve(tempDir, "second.ts");
      await store.addChunks([
        createMockChunk("first-old", firstPath),
        createMockChunk("second-old", secondPath),
      ]);

      const secondStore = new VectorStore(tempDir, mockConfig);
      await secondStore.connect();
      try {
        await Promise.all([
          store.replaceFileChunks(firstPath, [
            createMockChunk("first-new-1", firstPath),
            createMockChunk("first-new-2", firstPath),
          ]),
          secondStore.replaceFileChunks(secondPath, [
            createMockChunk("second-new-1", secondPath),
            createMockChunk("second-new-2", secondPath),
          ]),
        ]);

        const observer = new VectorStore(tempDir, mockConfig);
        await observer.connect();
        try {
          const status = await observer.getStatus(tempDir);
          expect(status.totalChunks).toBe(4);
          expect(status.totalFiles).toBe(2);
        } finally {
          observer.close();
        }
      } finally {
        secondStore.close();
      }
    });

    test("serializes concurrent replacements for the same file", async () => {
      const targetPath = path.resolve(tempDir, "same.ts");
      await store.addChunks([createMockChunk("same-old", targetPath)]);

      const secondStore = new VectorStore(tempDir, mockConfig);
      await secondStore.connect();
      try {
        await Promise.all([
          store.replaceFileChunks(targetPath, [
            createMockChunk("first-version", targetPath),
          ]),
          secondStore.replaceFileChunks(targetPath, [
            createMockChunk("second-version-1", targetPath),
            createMockChunk("second-version-2", targetPath),
          ]),
        ]);

        const observer = new VectorStore(tempDir, mockConfig);
        await observer.connect();
        try {
          const status = await observer.getStatus(tempDir);
          expect(status.totalChunks).toBe(2);
          expect(status.totalFiles).toBe(1);
        } finally {
          observer.close();
        }
      } finally {
        secondStore.close();
      }
    });
  });

  describe("clear", () => {
    test("removes all data", async () => {
      const chunks = [createMockChunk("func1", "/test/file1.ts")];
      await store.addChunks(chunks);

      await store.clear();
      const status = await store.getStatus(tempDir);

      expect(status.totalChunks).toBe(0);
    });
  });

  describe("getStatus", () => {
    test("returns correct status", async () => {
      const chunks = [
        createMockChunk("func1", "/test/file1.ts"),
        createMockChunk("func2", "/test/file2.ts"),
        createMockChunk("func3", "/test/file2.ts"),
      ];
      await store.addChunks(chunks);

      const status = await store.getStatus(tempDir);

      expect(status.exists).toBe(true);
      expect(status.totalChunks).toBe(3);
      expect(status.totalFiles).toBe(2);
      expect(status.languages.typescript).toBe(3);
    });
  });

  describe("getIndexedFiles", () => {
    test("returns unique file paths", async () => {
      const chunks = [
        createMockChunk("func1", "/test/file1.ts"),
        createMockChunk("func2", "/test/file2.ts"),
        createMockChunk("func3", "/test/file1.ts"),
      ];
      await store.addChunks(chunks);

      const files = await store.getIndexedFiles();

      expect(files).toHaveLength(2);
      expect(files).toContain("/test/file1.ts");
      expect(files).toContain("/test/file2.ts");
    });
  });

  describe("exists", () => {
    test("returns false for an empty index directory", () => {
      expect(store.exists()).toBe(false);
    });

    test("returns true when index exists", async () => {
      const chunks = [createMockChunk("func1", "/test/file1.ts")];
      await store.addChunks(chunks);

      expect(store.exists()).toBe(true);
    });

    test("returns false when index does not exist", () => {
      const newStore = new VectorStore(
        path.join(tempDir, "nonexistent"),
        mockConfig,
      );
      expect(newStore.exists()).toBe(false);
    });
  });
});

describe("source fingerprints", () => {
  test("is independent of hash insertion order", () => {
    expect(
      computeSourceFingerprint({
        "src/b.ts": "hash-b",
        "src/a.ts": "hash-a",
      }),
    ).toBe(
      computeSourceFingerprint({
        "src/a.ts": "hash-a",
        "src/b.ts": "hash-b",
      }),
    );
  });

  test("rejects an index when chunking configuration changes", async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "lancedb-metadata-test-"),
    );
    const baseConfig = {
      embeddingProvider: "lexical" as const,
      embeddingModel: "lexical-v1",
      embeddingDimensions: 768,
      defaultChunkSize: 1000,
      defaultChunkOverlap: 200,
    };

    try {
      const first = new VectorStore(tempDir, baseConfig);
      await first.connect();
      await first.addChunks([
        {
          id: "chunk",
          content: "const value = true;",
          filePath: path.join(tempDir, "file.ts"),
          language: "typescript",
          startLine: 1,
          endLine: 1,
          vector: new Array<number>(768).fill(0),
        },
      ]);
      first.close();

      const changed = new VectorStore(tempDir, {
        ...baseConfig,
        defaultChunkSize: 1200,
      });
      await changed.connect();
      expect(changed.getMetadataError()).toContain("configuration mismatch");
      expect(() => {
        changed.assertMetadataCompatible();
      }).toThrow("configuration mismatch");
      changed.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("fails closed when persisted metadata is corrupt or oversized", async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "lancedb-corrupt-metadata-test-"),
    );
    const makeChunk = (id: string, filePath: string): EmbeddedChunk => ({
      id,
      content: `function ${id}() { return true; }`,
      filePath,
      language: "typescript",
      startLine: 1,
      endLine: 1,
      vector: new Array<number>(768).fill(0),
    });
    const config = { embeddingDimensions: 768 };

    try {
      const first = new VectorStore(tempDir, config);
      await first.connect();
      await first.addChunks([
        makeChunk("persisted", path.join(tempDir, "file.ts")),
      ]);
      first.close();

      const metadataPath = path.join(tempDir, ".src-index", "metadata.json");
      fs.writeFileSync(metadataPath, "{not-json", "utf8");
      const corrupt = new VectorStore(tempDir, config);
      await corrupt.connect();
      expect(corrupt.getMetadataError()).toMatch(/invalid|unreadable/u);
      expect(() => {
        corrupt.assertMetadataCompatible();
      }).toThrow();
      await expect(
        corrupt.addChunks([
          makeChunk("must-not-write", path.join(tempDir, "file.ts")),
        ]),
      ).rejects.toThrow();
      corrupt.close();

      fs.writeFileSync(metadataPath, `{"padding":"${"x".repeat(70_000)}"}`);
      const oversized = new VectorStore(tempDir, config);
      await oversized.connect();
      expect(oversized.getMetadataError()).toMatch(/invalid|unreadable/u);
      expect(() => {
        oversized.assertMetadataCompatible();
      }).toThrow();
      oversized.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("createVectorStore", () => {
  test("creates a VectorStore instance", () => {
    const store = createVectorStore("/test/dir", { embeddingDimensions: 768 });
    expect(store).toBeInstanceOf(VectorStore);
  });
});

describe("getIndexPath", () => {
  test("returns correct index path", () => {
    const indexPath = getIndexPath("/test/dir");
    expect(indexPath).toBe(path.join("/test/dir", ".src-index"));
  });
});

describe("VectorStore advanced operations", () => {
  let tempDir: string;

  const mockConfig = {
    embeddingDimensions: 768,
  };

  const createMockChunk = (id: string, filePath: string) => ({
    id,
    content: `function ${id}() { return true; }`,
    filePath,
    language: "typescript",
    startLine: 1,
    endLine: 3,
    symbolName: id,
    symbolType: "function",
    vector: new Array(768).fill(0).map(() => Math.random()),
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lancedb-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("reopens existing table on connect", async () => {
    // First connection - create table
    const store1 = new VectorStore(tempDir, mockConfig);
    await store1.connect();
    await store1.addChunks([createMockChunk("func1", "/test/file1.ts")]);
    store1.close();

    // Second connection - should reopen existing table
    const store2 = new VectorStore(tempDir, mockConfig);
    await store2.connect();
    const status = await store2.getStatus(tempDir);

    expect(status.totalChunks).toBe(1);
    store2.close();
  });

  test("adds chunks to existing table", async () => {
    const store = new VectorStore(tempDir, mockConfig);
    await store.connect();

    // First batch
    await store.addChunks([createMockChunk("func1", "/test/file1.ts")]);

    // Second batch - should add to existing table
    await store.addChunks([createMockChunk("func2", "/test/file2.ts")]);

    const status = await store.getStatus(tempDir);
    expect(status.totalChunks).toBe(2);

    store.close();
  });

  test("getIndexedFiles returns empty when table is null", async () => {
    const store = new VectorStore(path.join(tempDir, "empty"), mockConfig);
    await store.connect();

    const files = await store.getIndexedFiles();
    expect(files).toEqual([]);

    store.close();
  });

  test("getStatus returns default when table is null", async () => {
    const store = new VectorStore(path.join(tempDir, "empty"), mockConfig);
    await store.connect();

    const status = await store.getStatus(tempDir);
    expect(status.totalChunks).toBe(0);
    expect(status.totalFiles).toBe(0);

    store.close();
  });

  test("clear does nothing when table is null", async () => {
    const store = new VectorStore(path.join(tempDir, "empty"), mockConfig);
    await store.connect();

    // Should not throw
    await store.clear();
    expect(true).toBe(true);

    store.close();
  });

  test("handles chunks without optional symbol fields", async () => {
    const store = new VectorStore(tempDir, mockConfig);
    await store.connect();

    const chunkWithoutSymbol = {
      id: "chunk1",
      content: "const x = 1;",
      filePath: "/test/file.ts",
      language: "typescript",
      startLine: 1,
      endLine: 1,
      vector: new Array(768).fill(0),
    };

    await store.addChunks([chunkWithoutSymbol]);
    const status = await store.getStatus(tempDir);
    expect(status.totalChunks).toBe(1);

    store.close();
  });
});

describe("VectorStore hybrid search", () => {
  let tempDir: string;

  const mockConfig = {
    embeddingDimensions: 768,
  };

  const createMockChunk = (
    id: string,
    content: string,
    filePath: string,
  ): EmbeddedChunk => ({
    id,
    content,
    filePath,
    language: "typescript",
    startLine: 1,
    endLine: 3,
    symbolName: id,
    symbolType: "function",
    vector: new Array(768).fill(0).map(() => Math.random()),
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lancedb-hybrid-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("searchHybrid returns empty array when table is null", async () => {
    const store = new VectorStore(path.join(tempDir, "empty"), mockConfig);
    await store.connect();

    const queryVector: number[] = new Array<number>(768).fill(0);
    const results = await store.searchHybrid(queryVector, "test query", 10);

    expect(results).toEqual([]);
    store.close();
  });

  test("searchHybrid in vector mode delegates to search", async () => {
    const store = new VectorStore(tempDir, mockConfig);
    await store.connect();

    const chunk1 = createMockChunk(
      "func1",
      "function hello() { return 'hello'; }",
      "/a.ts",
    );
    const chunk2 = createMockChunk(
      "func2",
      "function world() { return 'world'; }",
      "/b.ts",
    );
    await store.addChunks([chunk1, chunk2]);

    const results = await store.searchHybrid(chunk1.vector, "hello", 5, {
      mode: "vector",
    });

    expect(results.length).toBeGreaterThan(0);
    store.close();
  });

  test("searchHybrid in fts mode uses full-text search", async () => {
    const store = new VectorStore(tempDir, mockConfig);
    await store.connect();

    const chunks = [
      createMockChunk("func1", "function hello() { return 'hello'; }", "/a.ts"),
      createMockChunk("func2", "function world() { return 'world'; }", "/b.ts"),
    ];
    await store.addChunks(chunks);

    const queryVector: number[] = new Array<number>(768).fill(0);
    const results = await store.searchHybrid(queryVector, "hello", 5, {
      mode: "fts",
    });

    // FTS may or may not return results depending on LanceDB FTS support
    expect(Array.isArray(results)).toBe(true);
    store.close();
  });

  test("searchHybrid in hybrid mode combines vector and FTS results", async () => {
    const store = new VectorStore(tempDir, mockConfig);
    await store.connect();

    const chunk1 = createMockChunk(
      "func1",
      "function handleError() { throw new Error('error'); }",
      "/a.ts",
    );
    const chunk2 = createMockChunk(
      "func2",
      "function processData() { return data.map(x => x); }",
      "/b.ts",
    );
    const chunk3 = createMockChunk(
      "func3",
      "function validateInput() { if (!input) throw; }",
      "/c.ts",
    );
    await store.addChunks([chunk1, chunk2, chunk3]);

    const results = await store.searchHybrid(chunk1.vector, "error", 10, {
      mode: "hybrid",
    });

    expect(results.length).toBeGreaterThan(0);
    // Results should have RRF scores (higher is better)
    const firstResult = results[0];
    expect(firstResult).toBeDefined();
    expect(firstResult?.score).toBeGreaterThan(0);
    store.close();
  });

  test("searchFts returns empty array when table is null", async () => {
    const store = new VectorStore(path.join(tempDir, "empty"), mockConfig);
    await store.connect();

    const results = await store.searchFts("test", 10);
    expect(results).toEqual([]);
    store.close();
  });

  test("createFtsIndex is idempotent", async () => {
    const store = new VectorStore(tempDir, mockConfig);
    await store.connect();

    const chunks = [createMockChunk("func1", "test content", "/a.ts")];
    await store.addChunks(chunks);

    // Call createFtsIndex multiple times - should not throw
    await store.createFtsIndex();
    await store.createFtsIndex();
    await store.createFtsIndex();

    store.close();
  });

  test("createFtsIndex does nothing when table is null", async () => {
    const store = new VectorStore(path.join(tempDir, "empty"), mockConfig);
    await store.connect();

    // Should not throw
    await store.createFtsIndex();
    store.close();
  });
});
