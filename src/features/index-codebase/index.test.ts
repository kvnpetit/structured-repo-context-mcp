import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execute, indexCodebaseSchema } from "@features/index-codebase";
import * as embeddings from "@core/embeddings";

// Mock the entire embeddings module
vi.mock("@core/embeddings", () => ({
  createOllamaClient: vi.fn(),
  createVectorStore: vi.fn(),
  chunkFile: vi.fn(),
  enrichChunksFromFile: vi.fn(),
  shouldIndexFile: vi.fn(),
  validateEmbeddingBatch: vi.fn(
    (vectors: number[][], expectedCount: number, expectedDimensions: number) => {
      if (
        vectors.length !== expectedCount ||
        vectors.some((vector) => vector.length !== expectedDimensions)
      ) {
        throw new Error("Invalid embedding batch");
      }
    },
  ),
}));

describe("indexCodebaseSchema", () => {
  test("applies default directory", () => {
    const result = indexCodebaseSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.directory).toBe(".");
    }
  });

  test("validates valid input", () => {
    const result = indexCodebaseSchema.safeParse({
      directory: "/test/dir",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.directory).toBe("/test/dir");
    }
  });

  test("validates optional fields", () => {
    const result = indexCodebaseSchema.safeParse({
      directory: "/test/dir",
      force: true,
      concurrency: 4,
      exclude: ["*.log"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.force).toBe(true);
      expect(result.data.exclude).toEqual(["*.log"]);
    }
  });

  test("applies defaults", () => {
    const result = indexCodebaseSchema.safeParse({
      directory: "/test/dir",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.force).toBe(false);
      expect(result.data.exclude).toEqual([]);
    }
  });
});

describe("execute", () => {
  let tempDir: string;
  let mockHealthCheck: Mock;
  let mockEmbedBatch: Mock;
  let mockExists: Mock;
  let mockConnect: Mock;
  let mockClose: Mock;
  let mockClear: Mock;
  let mockAddChunks: Mock;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "index-test-"));
    vi.clearAllMocks();

    // Setup mocks
    mockHealthCheck = vi.fn().mockResolvedValue({ ok: true });
    mockEmbedBatch = vi
      .fn()
      .mockImplementation(async (texts: string[]) =>
        Promise.resolve(texts.map(() => new Array(768).fill(0).map(() => Math.random()))),
      );
    mockExists = vi.fn().mockReturnValue(false);
    mockConnect = vi.fn().mockResolvedValue(undefined);
    mockClose = vi.fn().mockResolvedValue(undefined);
    mockClear = vi.fn().mockResolvedValue(undefined);
    mockAddChunks = vi.fn().mockResolvedValue(undefined);

    (embeddings.createOllamaClient as Mock).mockReturnValue({
      healthCheck: mockHealthCheck,
      embedBatch: mockEmbedBatch,
    });

    (embeddings.createVectorStore as Mock).mockReturnValue({
      exists: mockExists,
      connect: mockConnect,
      close: mockClose,
      clear: mockClear,
      addChunks: mockAddChunks,
    });

    (embeddings.chunkFile as Mock).mockImplementation(async (filePath: string, content: string) =>
      Promise.resolve([
        {
          id: "chunk_1",
          content,
          filePath,
          language: "typescript",
          startLine: 1,
          endLine: 1,
        },
      ]),
    );

    // Mock enrichChunksFromFile to return enriched chunks
    (embeddings.enrichChunksFromFile as Mock).mockImplementation(
      async (chunks: embeddings.CodeChunk[]) =>
        Promise.resolve(
          chunks.map((chunk) => ({
            ...chunk,
            enrichedContent: chunk.content,
            containedSymbols: [],
            wasEnriched: false,
          })),
        ),
    );

    (embeddings.shouldIndexFile as Mock).mockImplementation(
      (filePath: string) => filePath.endsWith(".ts") || filePath.endsWith(".js"),
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns error for non-existent directory", async () => {
    const result = await execute({
      directory: "/nonexistent/path",
      force: false,
      concurrency: 4,
      exclude: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Directory not found");
  });

  test("honors an already-aborted request before contacting the provider", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await execute(
      {
        directory: tempDir,
        force: false,
        concurrency: 4,
        exclude: [],
      },
      { signal: controller.signal },
    );

    expect(result).toEqual({ success: false, error: "Operation cancelled" });
    expect(mockHealthCheck).not.toHaveBeenCalled();
  });

  test("returns message for empty directory", async () => {
    const result = await execute({
      directory: tempDir,
      force: false,
      concurrency: 4,
      exclude: [],
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("No indexable files found");
    expect(mockClose).toHaveBeenCalledOnce();
  });

  test("clears a previous index when force re-indexing an empty directory", async () => {
    mockExists.mockReturnValue(true);

    const result = await execute({
      directory: tempDir,
      force: true,
      concurrency: 4,
      exclude: [],
    });

    expect(result.success).toBe(true);
    expect(mockClear).toHaveBeenCalledOnce();
    expect(mockAddChunks).not.toHaveBeenCalled();
  });

  test("indexes TypeScript files", async () => {
    // Create test files
    fs.writeFileSync(path.join(tempDir, "test.ts"), 'export function hello() { return "world"; }');

    const result = await execute({
      directory: tempDir,
      force: false,
      concurrency: 4,
      exclude: [],
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("filesIndexed", 1);
    expect(result.data).toHaveProperty("chunksCreated");
  });

  test("persists hashes for update_index after initial indexing", async () => {
    const filePath = path.join(tempDir, "test.ts");
    fs.writeFileSync(filePath, 'export function hello() { return "world"; }');

    const result = await execute({
      directory: tempDir,
      force: false,
      concurrency: 4,
      exclude: [],
    });

    expect(result.success).toBe(true);

    const cachePath = path.join(tempDir, ".src-index", ".src-index-hashes.json");
    expect(fs.existsSync(cachePath)).toBe(true);

    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Record<string, string>;
    expect(cache[path.resolve(filePath)]).toMatch(/^[a-f0-9]{64}$/);
  });

  test("excludes specified patterns", async () => {
    // Create files
    fs.writeFileSync(path.join(tempDir, "included.ts"), "export const x = 1;");
    fs.mkdirSync(path.join(tempDir, "excluded"));
    fs.writeFileSync(path.join(tempDir, "excluded", "skip.ts"), "export const y = 2;");

    const result = await execute({
      directory: tempDir,
      force: false,
      concurrency: 4,
      exclude: ["excluded"],
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("filesIndexed", 1);
  });

  test("excludes patterns from .gitignore", async () => {
    // Create .gitignore with node_modules
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "node_modules\n");

    // Create files
    fs.writeFileSync(path.join(tempDir, "main.ts"), 'import x from "pkg";');
    fs.mkdirSync(path.join(tempDir, "node_modules"));
    fs.writeFileSync(path.join(tempDir, "node_modules", "pkg.ts"), "export default 1;");

    const result = await execute({
      directory: tempDir,
      force: false,
      concurrency: 4,
      exclude: [],
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("filesIndexed", 2);
    const indexedPaths = vi
      .mocked(embeddings.chunkFile)
      .mock.calls.map(([filePath]) => path.basename(filePath));
    expect(indexedPaths).toEqual(expect.arrayContaining([".gitignore", "main.ts"]));
    expect(indexedPaths).not.toContain("pkg.ts");
  });

  test("excludes hidden folders starting with dot", async () => {
    // Create files
    fs.writeFileSync(path.join(tempDir, "main.ts"), "export const x = 1;");
    fs.mkdirSync(path.join(tempDir, ".hidden"));
    fs.writeFileSync(path.join(tempDir, ".hidden", "secret.ts"), "export default 1;");

    const result = await execute({
      directory: tempDir,
      force: false,
      concurrency: 4,
      exclude: [],
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("filesIndexed", 1);
  });

  test("returns error when Ollama health check fails", async () => {
    mockHealthCheck.mockResolvedValue({
      ok: false,
      error: "Ollama unavailable",
    });

    const result = await execute({
      directory: tempDir,
      force: false,
      concurrency: 4,
      exclude: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Ollama unavailable");
  });

  test("returns error when Ollama health check fails without message", async () => {
    mockHealthCheck.mockResolvedValue({ ok: false });

    const result = await execute({
      directory: tempDir,
      force: false,
      concurrency: 4,
      exclude: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Ollama is not available");
  });

  test("returns error when index exists and force is false", async () => {
    mockExists.mockReturnValue(true);

    const result = await execute({
      directory: tempDir,
      force: false,
      concurrency: 4,
      exclude: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Index already exists");
  });

  test("clears existing index when force is true", async () => {
    mockExists.mockReturnValue(true);
    fs.writeFileSync(path.join(tempDir, "test.ts"), "export const x = 1;");

    const result = await execute({
      directory: tempDir,
      force: true,
      concurrency: 4,
      exclude: [],
    });

    expect(result.success).toBe(true);
    expect(mockClear).toHaveBeenCalled();
  });

  test("handles file processing errors", async () => {
    fs.writeFileSync(path.join(tempDir, "test.ts"), "export const x = 1;");

    (embeddings.chunkFile as Mock).mockRejectedValueOnce(new Error("Parse error"));

    const result = await execute({
      directory: tempDir,
      force: false,
      concurrency: 4,
      exclude: [],
    });

    expect(result.success).toBe(true);
    const data = result.data as { errors: string[] };
    expect(data.errors.length).toBeGreaterThan(0);
    expect(data.errors[0]).toContain("Error processing");
  });

  test("handles embedding batch errors", async () => {
    fs.writeFileSync(path.join(tempDir, "test.ts"), "export const x = 1;");

    mockEmbedBatch.mockRejectedValueOnce(new Error("Embedding failed"));

    const result = await execute({
      directory: tempDir,
      force: false,
      concurrency: 4,
      exclude: [],
    });

    expect(result.success).toBe(false);
    const data = result.data as { errors: string[] };
    expect(data.errors.length).toBeGreaterThan(0);
    expect(data.errors[0]).toContain("Embedding batch error");
    expect(mockAddChunks).not.toHaveBeenCalled();
  });

  test("does not publish later embedding batches after one batch fails", async () => {
    for (let index = 0; index < 11; index++) {
      fs.writeFileSync(
        path.join(tempDir, `file-${String(index)}.ts`),
        `export const value${String(index)} = ${String(index)};`,
      );
    }
    mockEmbedBatch.mockRejectedValueOnce(new Error("first batch failed"));

    const result = await execute({
      directory: tempDir,
      force: true,
      concurrency: 4,
      exclude: [],
    });

    expect(mockEmbedBatch).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(mockClear).not.toHaveBeenCalled();
    expect(mockAddChunks).not.toHaveBeenCalled();
  });

  test("reports message with errors when partial success", async () => {
    fs.writeFileSync(path.join(tempDir, "test1.ts"), "export const a = 1;");
    fs.writeFileSync(path.join(tempDir, "test2.ts"), "export const b = 2;");

    (embeddings.chunkFile as Mock)
      .mockResolvedValueOnce([
        {
          id: "1",
          content: "a",
          filePath: "test1.ts",
          language: "typescript",
          startLine: 1,
          endLine: 1,
        },
      ])
      .mockRejectedValueOnce(new Error("Parse error"));

    const result = await execute({
      directory: tempDir,
      force: false,
      concurrency: 4,
      exclude: [],
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("with");
    expect(result.message).toContain("errors");
  });

  test("handles global indexing errors", async () => {
    fs.writeFileSync(path.join(tempDir, "test.ts"), "export const x = 1;");

    mockConnect.mockRejectedValueOnce(new Error("Connection failed"));

    const result = await execute({
      directory: tempDir,
      force: false,
      concurrency: 4,
      exclude: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Indexing failed");
    expect(result.error).toContain("Connection failed");
  });

  test("handles non-Error exceptions in file processing", async () => {
    fs.writeFileSync(path.join(tempDir, "test.ts"), "export const x = 1;");

    (embeddings.chunkFile as Mock).mockRejectedValueOnce("string error");

    const result = await execute({
      directory: tempDir,
      force: false,
      concurrency: 4,
      exclude: [],
    });

    expect(result.success).toBe(true);
    const data = result.data as { errors: string[] };
    expect(data.errors[0]).toContain("string error");
  });

  test("handles non-Error exceptions in embedding batch", async () => {
    fs.writeFileSync(path.join(tempDir, "test.ts"), "export const x = 1;");

    mockEmbedBatch.mockRejectedValueOnce("embedding string error");

    const result = await execute({
      directory: tempDir,
      force: false,
      concurrency: 4,
      exclude: [],
    });

    expect(result.success).toBe(false);
    const data = result.data as { errors: string[] };
    expect(data.errors[0]).toContain("embedding string error");
  });

  test("handles non-Error exceptions in global catch", async () => {
    fs.writeFileSync(path.join(tempDir, "test.ts"), "export const x = 1;");

    mockConnect.mockRejectedValueOnce("connection string error");

    const result = await execute({
      directory: tempDir,
      force: false,
      concurrency: 4,
      exclude: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("connection string error");
  });
});
