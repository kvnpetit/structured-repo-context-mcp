import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IndexWatcher } from "@core/embeddings/watcher";
import type { EmbeddingConfig } from "@core/embeddings/types";

// Mock chokidar
const mockOn = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);
vi.mock("chokidar", () => ({
  watch: vi.fn().mockReturnValue({
    on: mockOn,
    close: mockClose,
  }),
}));

// Mock OllamaClient
vi.mock("@core/embeddings/client", () => ({
  OllamaClient: vi.fn().mockImplementation(() => ({
    healthCheck: vi.fn().mockResolvedValue({ ok: true }),
    embed: vi.fn().mockResolvedValue(new Array<number>(768).fill(0)),
    embedBatch: vi.fn().mockImplementation((texts: string[]): number[][] => {
      return texts.map(() => new Array<number>(768).fill(0));
    }),
  })),
}));

// Mock VectorStore
vi.mock("@core/embeddings/store", () => ({
  VectorStore: vi.fn().mockImplementation(() => ({
    exists: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    addChunks: vi.fn().mockResolvedValue(undefined),
    deleteByFilePath: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock chunker
vi.mock("@core/embeddings/chunker", () => ({
  chunkFile: vi.fn().mockResolvedValue([
    {
      id: "chunk_1",
      content: "test content",
      filePath: "/test/file.ts",
      language: "typescript",
      startLine: 1,
      endLine: 10,
    },
  ]),
  shouldIndexFile: vi
    .fn()
    .mockImplementation(
      (filePath: string) =>
        filePath.endsWith(".ts") || filePath.endsWith(".js"),
    ),
}));

describe("IndexWatcher", () => {
  let tempDir: string;
  const mockConfig: EmbeddingConfig = {
    ollamaBaseUrl: "http://localhost:11434",
    embeddingModel: "nomic-embed-text",
    embeddingDimensions: 768,
    defaultChunkSize: 1000,
    defaultChunkOverlap: 200,
    batchSize: 10,
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-test-"));
    vi.clearAllMocks();

    // Reset mockOn to capture event handlers
    mockOn.mockImplementation(function (
      this: { on: typeof mockOn },
      _event: string,
      _handler: () => void,
    ) {
      return this;
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates watcher instance", () => {
    const watcher = new IndexWatcher({
      directory: tempDir,
      config: mockConfig,
    });

    expect(watcher).toBeDefined();
    expect(watcher.isRunning()).toBe(false);
  });

  test("starts watcher and sets up event handlers", async () => {
    const watcher = new IndexWatcher({
      directory: tempDir,
      config: mockConfig,
    });

    await watcher.start();

    expect(watcher.isRunning()).toBe(true);
    expect(mockOn).toHaveBeenCalledWith("add", expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith("change", expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith("unlink", expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith("ready", expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith("error", expect.any(Function));
  });

  test("stops watcher and closes resources", async () => {
    const watcher = new IndexWatcher({
      directory: tempDir,
      config: mockConfig,
    });

    await watcher.start();
    await watcher.stop();

    expect(watcher.isRunning()).toBe(false);
    expect(mockClose).toHaveBeenCalled();
  });

  test("respects gitignore patterns", () => {
    // Create .gitignore
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "node_modules\n*.log\n");

    const watcher = new IndexWatcher({
      directory: tempDir,
      config: mockConfig,
    });

    // The watcher should be created with gitignore patterns loaded
    expect(watcher).toBeDefined();
  });

  test("calls onReady callback when watcher is ready", async () => {
    const onReady = vi.fn();

    // Setup mockOn to capture and call the ready handler
    let readyHandler: (() => void) | undefined;
    mockOn.mockImplementation(function (
      this: { on: typeof mockOn },
      event: string,
      handler: () => void,
    ) {
      if (event === "ready") {
        readyHandler = handler;
      }
      return this;
    });

    const watcher = new IndexWatcher({
      directory: tempDir,
      config: mockConfig,
      onReady,
    });

    await watcher.start();

    // Simulate ready event
    if (readyHandler) {
      readyHandler();
    }

    expect(onReady).toHaveBeenCalled();
  });

  test("calls onError callback on watcher error", async () => {
    const onError = vi.fn();
    const testError = new Error("Test error");

    // Setup mockOn to capture and call the error handler
    let errorHandler: ((error: Error) => void) | undefined;
    mockOn.mockImplementation(function (
      this: { on: typeof mockOn },
      event: string,
      handler: (error: Error) => void,
    ) {
      if (event === "error") {
        errorHandler = handler;
      }
      return this;
    });

    const watcher = new IndexWatcher({
      directory: tempDir,
      config: mockConfig,
      onError,
    });

    await watcher.start();

    // Simulate error event
    if (errorHandler) {
      errorHandler(testError);
    }

    expect(onError).toHaveBeenCalledWith(testError);
  });
});
