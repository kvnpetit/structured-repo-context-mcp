import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execute, searchCodeSchema } from "@features/search-code";

// Mock the embeddings module
vi.mock("@core/embeddings", () => ({
  createOllamaClient: vi.fn().mockImplementation(() => ({
    healthCheck: vi.fn().mockResolvedValue({ ok: true }),
    embed: vi
      .fn()
      .mockResolvedValue(new Array(768).fill(0).map(() => Math.random())),
  })),
  createVectorStore: vi.fn().mockImplementation(() => ({
    exists: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([
      {
        chunk: {
          id: "chunk_1",
          content: 'function hello() { return "world"; }',
          filePath: "/test/file.ts",
          language: "typescript",
          startLine: 1,
          endLine: 3,
          symbolName: "hello",
          symbolType: "function",
        },
        score: 0.5,
      },
    ]),
  })),
}));

describe("searchCodeSchema", () => {
  test("validates required fields", () => {
    const result = searchCodeSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("validates valid input", () => {
    const result = searchCodeSchema.safeParse({
      query: "parse AST",
      directory: "/test/dir",
    });
    expect(result.success).toBe(true);
  });

  test("validates query is not empty", () => {
    const result = searchCodeSchema.safeParse({
      query: "",
      directory: "/test/dir",
    });
    expect(result.success).toBe(false);
  });

  test("validates limit is positive integer", () => {
    const result = searchCodeSchema.safeParse({
      query: "test",
      directory: "/test/dir",
      limit: -1,
    });
    expect(result.success).toBe(false);
  });

  test("validates threshold range", () => {
    const valid = searchCodeSchema.safeParse({
      query: "test",
      directory: "/test/dir",
      threshold: 1.5,
    });
    expect(valid.success).toBe(true);

    const invalid = searchCodeSchema.safeParse({
      query: "test",
      directory: "/test/dir",
      threshold: 3,
    });
    expect(invalid.success).toBe(false);
  });

  test("applies defaults", () => {
    const result = searchCodeSchema.safeParse({
      query: "test",
      directory: "/test/dir",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
    }
  });
});

describe("execute", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test("returns error for non-existent directory", async () => {
    const result = await execute({
      query: "test query",
      directory: "/nonexistent/path",
      limit: 10,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Directory not found");
  });

  test("searches successfully with results", async () => {
    const result = await execute({
      query: "hello function",
      directory: tempDir,
      limit: 10,
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("results");
    expect(result.data).toHaveProperty("resultsCount");
    expect(result.message).toContain("Found");
  });

  test("includes query in output", async () => {
    const result = await execute({
      query: "specific query",
      directory: tempDir,
      limit: 5,
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("query", "specific query");
  });
});
