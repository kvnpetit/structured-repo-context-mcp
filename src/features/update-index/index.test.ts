import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type Mock,
} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execute, updateIndexSchema } from "@features/update-index";
import * as embeddings from "@core/embeddings";

// Mock the entire embeddings module
vi.mock("@core/embeddings", () => ({
  createOllamaClient: vi.fn(),
  createVectorStore: vi.fn(),
  chunkFile: vi.fn(),
  enrichChunksFromFile: vi.fn(),
  shouldIndexFile: vi.fn(),
  validateEmbeddingBatch: vi.fn(
    (
      vectors: number[][],
      expectedCount: number,
      expectedDimensions: number,
    ) => {
      if (
        vectors.length !== expectedCount ||
        vectors.some((vector) => vector.length !== expectedDimensions)
      ) {
        throw new Error("Invalid embedding batch");
      }
    },
  ),
}));

describe("updateIndexSchema", () => {
  test("applies default directory", () => {
    const result = updateIndexSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.directory).toBe(".");
    }
  });

  test("validates valid input", () => {
    const result = updateIndexSchema.safeParse({
      directory: "/test/dir",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.directory).toBe("/test/dir");
    }
  });

  test("validates optional fields", () => {
    const result = updateIndexSchema.safeParse({
      directory: "/test/dir",
      dryRun: true,
      force: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dryRun).toBe(true);
      expect(result.data.force).toBe(true);
    }
  });

  test("applies defaults", () => {
    const result = updateIndexSchema.safeParse({
      directory: "/test/dir",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dryRun).toBe(false);
      expect(result.data.force).toBe(false);
      expect(result.data.concurrency).toBe(4);
    }
  });

  test("validates concurrency parameter", () => {
    const result = updateIndexSchema.safeParse({
      directory: "/test/dir",
      concurrency: 8,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.concurrency).toBe(8);
    }
  });

  test("rejects invalid concurrency", () => {
    const negative = updateIndexSchema.safeParse({ concurrency: -1 });
    expect(negative.success).toBe(false);

    const zero = updateIndexSchema.safeParse({ concurrency: 0 });
    expect(zero.success).toBe(false);

    const float = updateIndexSchema.safeParse({ concurrency: 1.5 });
    expect(float.success).toBe(false);
  });
});

describe("execute", () => {
  let tempDir: string;
  let mockHealthCheck: Mock;
  let mockEmbedBatch: Mock;
  let mockExists: Mock;
  let mockConnect: Mock;
  let mockClose: Mock;
  let mockGetIndexedFiles: Mock;
  let mockReplaceFilesChunks: Mock;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "update-index-test-"));
    vi.clearAllMocks();

    // Setup mocks
    mockHealthCheck = vi.fn().mockResolvedValue({ ok: true });
    mockEmbedBatch = vi
      .fn()
      .mockImplementation(async (texts: string[]) =>
        Promise.resolve(
          texts.map(() => new Array(768).fill(0).map(() => Math.random())),
        ),
      );
    mockExists = vi.fn().mockReturnValue(true);
    mockConnect = vi.fn().mockResolvedValue(undefined);
    mockClose = vi.fn().mockResolvedValue(undefined);
    mockGetIndexedFiles = vi.fn().mockResolvedValue([]);
    mockReplaceFilesChunks = vi.fn().mockResolvedValue(undefined);

    (embeddings.createOllamaClient as Mock).mockReturnValue({
      healthCheck: mockHealthCheck,
      embedBatch: mockEmbedBatch,
    });

    (embeddings.createVectorStore as Mock).mockReturnValue({
      exists: mockExists,
      connect: mockConnect,
      close: mockClose,
      assertMetadataCompatible: vi.fn(),
      getIndexedFiles: mockGetIndexedFiles,
      replaceFilesChunks: mockReplaceFilesChunks,
    });

    (embeddings.chunkFile as Mock).mockResolvedValue([
      {
        id: "chunk-1",
        content: "test content",
        filePath: "/test/file.ts",
        language: "typescript",
        startLine: 1,
        endLine: 10,
      },
    ]);

    (embeddings.enrichChunksFromFile as Mock).mockImplementation(
      async (chunks: { content: string }[]) =>
        Promise.resolve(
          chunks.map((c) => ({
            ...c,
            enrichedContent: c.content,
            containedSymbols: [],
            wasEnriched: true,
          })),
        ),
    );

    (embeddings.shouldIndexFile as Mock).mockReturnValue(true);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test("returns error for non-existent directory", async () => {
    const result = await execute({
      directory: "/non/existent/directory",
      dryRun: false,
      force: false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Directory not found");
  });

  test("returns error when index does not exist", async () => {
    mockExists.mockReturnValue(false);
    const result = await execute({
      directory: tempDir,
      dryRun: false,
      force: false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No index found");
  });

  test("honors an already-aborted request before contacting the provider", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await execute(
      {
        directory: tempDir,
        dryRun: false,
        force: false,
      },
      { signal: controller.signal },
    );

    expect(result).toEqual({ success: false, error: "Operation cancelled" });
    expect(mockHealthCheck).not.toHaveBeenCalled();
  });

  test("returns error when Ollama health check fails", async () => {
    mockHealthCheck.mockResolvedValue({
      ok: false,
      error: "Connection refused",
    });
    const result = await execute({
      directory: tempDir,
      dryRun: false,
      force: false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Connection refused");
  });

  test("returns error when Ollama health check fails without message", async () => {
    mockHealthCheck.mockResolvedValue({ ok: false });
    const result = await execute({
      directory: tempDir,
      dryRun: false,
      force: false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Ollama is not available");
  });

  test("dry run reports no changes when index is up to date", async () => {
    const result = await execute({
      directory: tempDir,
      dryRun: true,
      force: false,
    });
    expect(result.success).toBe(true);
    expect(result.message).toContain("up to date");
  });

  test("dry run detects new files", async () => {
    // Create a test file
    const testFile = path.join(tempDir, "test.ts");
    fs.writeFileSync(testFile, "const x = 1;");

    const result = await execute({
      directory: tempDir,
      dryRun: true,
      force: false,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("add");
  });

  test("detects and removes deleted files", async () => {
    // Mock that a file exists in index but not on disk
    const deletedFile = path.join(tempDir, "deleted.ts");
    mockGetIndexedFiles.mockResolvedValue([deletedFile]);

    const result = await execute({
      directory: tempDir,
      dryRun: true,
      force: false,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("remove");
  });

  test("processes new files successfully", async () => {
    // Create a test file
    const testFile = path.join(tempDir, "test.ts");
    fs.writeFileSync(testFile, "const x = 1;");

    const result = await execute({
      directory: tempDir,
      dryRun: false,
      force: false,
    });

    expect(result.success).toBe(true);
    expect(mockReplaceFilesChunks).toHaveBeenCalled();
  });

  test("handles errors during file processing", async () => {
    // Create a test file
    const testFile = path.join(tempDir, "test.ts");
    fs.writeFileSync(testFile, "const x = 1;");

    (embeddings.chunkFile as Mock).mockRejectedValue(new Error("Parse error"));

    const result = await execute({
      directory: tempDir,
      dryRun: false,
      force: false,
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("errors");
  });

  test("retains the old hash and retries a modified file after failure", async () => {
    const testFile = path.join(tempDir, "retry.ts");
    fs.writeFileSync(testFile, "const current = true;");
    mockGetIndexedFiles.mockResolvedValue([testFile]);

    const cacheDir = path.join(tempDir, ".src-index");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, ".src-index-hashes.json");
    fs.writeFileSync(cachePath, JSON.stringify({ [testFile]: "old-hash" }));

    (embeddings.chunkFile as Mock).mockRejectedValueOnce(
      new Error("transient parse failure"),
    );

    const firstResult = await execute({ directory: tempDir });
    expect(firstResult.success).toBe(true);
    expect(mockReplaceFilesChunks).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(cachePath, "utf-8"))).toEqual({
      [testFile]: "old-hash",
    });

    const secondResult = await execute({ directory: tempDir });
    expect(secondResult.success).toBe(true);
    expect(embeddings.chunkFile).toHaveBeenCalledTimes(2);
    expect(mockReplaceFilesChunks).toHaveBeenCalledTimes(1);
  });

  test("does not commit a partial embedding batch and retries it", async () => {
    const testFile = path.join(tempDir, "partial.ts");
    fs.writeFileSync(testFile, "const current = true;");
    mockGetIndexedFiles.mockResolvedValue([testFile]);

    const cacheDir = path.join(tempDir, ".src-index");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, ".src-index-hashes.json");
    fs.writeFileSync(cachePath, JSON.stringify({ [testFile]: "old-hash" }));

    mockEmbedBatch.mockResolvedValueOnce([]);

    const firstResult = await execute({ directory: tempDir });
    expect(firstResult.success).toBe(true);
    expect(mockReplaceFilesChunks).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(cachePath, "utf-8"))).toEqual({
      [testFile]: "old-hash",
    });

    const secondResult = await execute({ directory: tempDir });
    expect(secondResult.success).toBe(true);
    expect(mockReplaceFilesChunks).toHaveBeenCalledTimes(1);
  });

  test("handles general errors", async () => {
    mockConnect.mockRejectedValue(new Error("Connection failed"));

    const result = await execute({
      directory: tempDir,
      dryRun: false,
      force: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Update failed");
  });

  test("handles non-Error exceptions", async () => {
    mockConnect.mockRejectedValue("String error");

    const result = await execute({
      directory: tempDir,
      dryRun: false,
      force: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("String error");
  });

  test("force flag ignores hash cache", async () => {
    // Create hash cache directory and file
    const indexDir = path.join(tempDir, ".src-index");
    fs.mkdirSync(indexDir, { recursive: true });
    const hashCachePath = path.join(indexDir, ".src-index-hashes.json");

    // Create a test file
    const testFile = path.join(tempDir, "test.ts");
    fs.writeFileSync(testFile, "const x = 1;");

    // Create hash cache with the same hash
    const content = fs.readFileSync(testFile, "utf-8");
    const crypto = await import("node:crypto");
    const hash = crypto
      .createHash("sha256")
      .update(content, "utf8")
      .digest("hex");
    fs.writeFileSync(hashCachePath, JSON.stringify({ [testFile]: hash }));

    // Also mock it as indexed
    mockGetIndexedFiles.mockResolvedValue([testFile]);

    // Without force, file should be unchanged
    const resultNoForce = await execute({
      directory: tempDir,
      dryRun: true,
      force: false,
    });
    expect(resultNoForce.success).toBe(true);
    expect(resultNoForce.message).toContain("up to date");

    // With force, file should be detected as modified
    const resultWithForce = await execute({
      directory: tempDir,
      dryRun: true,
      force: true,
    });
    expect(resultWithForce.success).toBe(true);
    // Force treats all indexed files as modified
  });

  test("removes deleted files from index", async () => {
    const deletedFile = path.join(tempDir, "deleted.ts");
    mockGetIndexedFiles.mockResolvedValue([deletedFile]);

    const result = await execute({
      directory: tempDir,
      dryRun: false,
      force: false,
    });

    expect(result.success).toBe(true);
    const replacements = mockReplaceFilesChunks.mock.calls[0]?.[0] as Map<
      string,
      embeddings.EmbeddedChunk[]
    >;
    expect(replacements.get(deletedFile)).toEqual([]);
  });

  test("processes multiple files in parallel", async () => {
    // Create multiple test files
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(tempDir, `file${String(i)}.ts`),
        `const x${String(i)} = ${String(i)};`,
      );
    }

    const result = await execute({
      directory: tempDir,
      dryRun: false,
      force: false,
      concurrency: 3,
    });

    expect(result.success).toBe(true);
    expect(mockReplaceFilesChunks).toHaveBeenCalled();
    // All 5 files should have been processed
    expect(mockEmbedBatch).toHaveBeenCalledTimes(5);
  });

  test("returns up to date message when no files changed", async () => {
    // Empty directory, no indexed files → nothing to do
    const result = await execute({
      directory: tempDir,
      dryRun: false,
      force: false,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("up to date");
  });

  test("handles corrupted hash cache gracefully", async () => {
    // Write invalid JSON to the hash cache file
    const indexDir = path.join(tempDir, ".src-index");
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(
      path.join(indexDir, ".src-index-hashes.json"),
      "{ invalid json }",
    );

    const testFile = path.join(tempDir, "test.ts");
    fs.writeFileSync(testFile, "const x = 1;");

    // Should succeed even with a corrupted cache (falls back to treating files as new)
    const result = await execute({
      directory: tempDir,
      dryRun: true,
      force: false,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("add");
  });

  test("deletes and re-indexes modified files", async () => {
    const testFile = path.join(tempDir, "test.ts");
    fs.writeFileSync(testFile, "const x = 1;");

    // Mark file as already indexed so it becomes a "modify" instead of "add"
    mockGetIndexedFiles.mockResolvedValue([testFile]);
    // No hash cache → hash is different → file is modified

    const result = await execute({
      directory: tempDir,
      dryRun: false,
      force: false,
    });

    expect(result.success).toBe(true);
    const replacements = mockReplaceFilesChunks.mock.calls[0]?.[0] as Map<
      string,
      embeddings.EmbeddedChunk[]
    >;
    expect(replacements.get(testFile)).toHaveLength(1);
  });

  test("skips files that produce no chunks", async () => {
    const testFile = path.join(tempDir, "test.ts");
    fs.writeFileSync(testFile, "const x = 1;");

    (embeddings.chunkFile as Mock).mockResolvedValue([]);

    const result = await execute({
      directory: tempDir,
      dryRun: false,
      force: false,
    });

    expect(result.success).toBe(true);
    const replacements = mockReplaceFilesChunks.mock.calls[0]?.[0] as Map<
      string,
      embeddings.EmbeddedChunk[]
    >;
    expect(replacements.get(testFile)).toEqual([]);
  });

  test("dry run truncates list when more than 10 files added", async () => {
    // Create 12 files so the "...and X more" branch is triggered
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(
        path.join(tempDir, `file${String(i)}.ts`),
        `const x${String(i)} = ${String(i)};`,
      );
    }

    const result = await execute({
      directory: tempDir,
      dryRun: true,
      force: false,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("... and");
    expect(result.message).toContain("more");
  });

  test("dry run truncates list when more than 10 files removed", async () => {
    // Put 12 non-existent files in the index
    const deletedFiles = Array.from({ length: 12 }, (_, i) =>
      path.join(tempDir, `deleted${String(i)}.ts`),
    );
    mockGetIndexedFiles.mockResolvedValue(deletedFiles);
    // None exist on disk → all are "removed"

    const result = await execute({
      directory: tempDir,
      dryRun: true,
      force: false,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("... and");
  });

  test("dry run truncates list when more than 10 files modified", async () => {
    // Create 12 files and mark them all as indexed (so they become "modified")
    const files: string[] = [];
    for (let i = 0; i < 12; i++) {
      const f = path.join(tempDir, `mod${String(i)}.ts`);
      fs.writeFileSync(f, `const m${String(i)} = ${String(i)};`);
      files.push(f);
    }
    mockGetIndexedFiles.mockResolvedValue(files);
    // No hash cache → all files have changed hashes → all are "modified"

    const result = await execute({
      directory: tempDir,
      dryRun: true,
      force: false,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("... and");
  });
});
