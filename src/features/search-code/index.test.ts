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
import { execute, searchCodeSchema } from "@features/search-code";
import * as embeddings from "@core/embeddings";

// Mock the embeddings module
vi.mock("@core/embeddings", () => ({
  createOllamaClient: vi.fn(),
  createVectorStore: vi.fn(),
  buildCallGraph: vi.fn(),
  getCallContext: vi.fn(),
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
      expect(result.data.mode).toBe("hybrid");
      expect(result.data.includeCallContext).toBe(true);
      expect(result.data.rerank).toBe("lexical");
      expect(result.data.vectorWeight).toBe(0.5);
      expect(result.data.include_tests).toBe(true);
      expect(result.data.min_confidence).toBe(0);
      expect(result.data.max_content_bytes).toBe(20_000);
      expect(result.data.neighbor_window).toBe(0);
    }
  });

  test("validates mode enum values", () => {
    const validModes = ["vector", "fts", "hybrid"];
    for (const mode of validModes) {
      const result = searchCodeSchema.safeParse({
        query: "test",
        directory: "/test/dir",
        mode,
      });
      expect(result.success).toBe(true);
    }

    const invalidResult = searchCodeSchema.safeParse({
      query: "test",
      directory: "/test/dir",
      mode: "invalid",
    });
    expect(invalidResult.success).toBe(false);
  });

  test("validates reranking mode values", () => {
    expect(
      searchCodeSchema.safeParse({ query: "test", rerank: "lexical" }).success,
    ).toBe(true);
    expect(
      searchCodeSchema.safeParse({ query: "test", rerank: "none" }).success,
    ).toBe(true);
    expect(
      searchCodeSchema.safeParse({ query: "test", rerank: "code" }).success,
    ).toBe(true);
    expect(
      searchCodeSchema.safeParse({ query: "test", rerank: "llm" }).success,
    ).toBe(false);
  });

  test("validates the hybrid vector weight", () => {
    expect(
      searchCodeSchema.safeParse({ query: "test", vectorWeight: 0 }).success,
    ).toBe(true);
    expect(
      searchCodeSchema.safeParse({ query: "test", vectorWeight: 1 }).success,
    ).toBe(true);
    expect(
      searchCodeSchema.safeParse({ query: "test", vectorWeight: 1.1 }).success,
    ).toBe(false);
  });
});

describe("execute", () => {
  let tempDir: string;
  let mockHealthCheck: Mock;
  let mockEmbed: Mock;
  let mockExists: Mock;
  let mockConnect: Mock;
  let mockClose: Mock;
  let mockSearchHybrid: Mock;
  let mockGetAdjacentChunks: Mock;
  let mockBuildCallGraph: Mock;
  let mockGetCallContext: Mock;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-test-"));
    vi.clearAllMocks();

    // Setup mocks
    mockHealthCheck = vi.fn().mockResolvedValue({ ok: true });
    mockEmbed = vi
      .fn()
      .mockResolvedValue(new Array(768).fill(0).map(() => Math.random()));
    mockExists = vi.fn().mockReturnValue(true);
    mockConnect = vi.fn().mockResolvedValue(undefined);
    mockClose = vi.fn().mockResolvedValue(undefined);
    mockSearchHybrid = vi.fn().mockResolvedValue([
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
    ]);

    mockBuildCallGraph = vi.fn().mockResolvedValue({});
    mockGetCallContext = vi.fn().mockReturnValue(null);
    mockGetAdjacentChunks = vi.fn().mockResolvedValue({
      neighbors: [],
      candidatesConsidered: 0,
      truncated: false,
    });

    (embeddings.createOllamaClient as Mock).mockReturnValue({
      healthCheck: mockHealthCheck,
      embed: mockEmbed,
    });

    (embeddings.createVectorStore as Mock).mockReturnValue({
      exists: mockExists,
      connect: mockConnect,
      close: mockClose,
      assertMetadataCompatible: vi.fn(),
      searchHybrid: mockSearchHybrid,
      getAdjacentChunks: mockGetAdjacentChunks,
    });

    (embeddings.buildCallGraph as Mock).mockImplementation(mockBuildCallGraph);
    (embeddings.getCallContext as Mock).mockImplementation(mockGetCallContext);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns error for non-existent directory", async () => {
    const result = await execute({
      query: "test query",
      directory: "/nonexistent/path",
      limit: 10,
      mode: "hybrid",
      includeCallContext: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Directory not found");
  });

  test("searches successfully with results", async () => {
    const result = await execute({
      query: "hello function",
      directory: tempDir,
      limit: 10,
      mode: "hybrid",
      includeCallContext: false,
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
      mode: "hybrid",
      includeCallContext: false,
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("query", "specific query");
  });

  test("bounds UTF-8 source content per result and reports truncation", async () => {
    mockSearchHybrid.mockResolvedValue([
      {
        chunk: {
          id: "large",
          content: `const message = "${"😀".repeat(100)}";`,
          filePath: "/test/large.ts",
          language: "typescript",
          startLine: 1,
          endLine: 1,
        },
        score: 0.5,
      },
    ]);

    const result = await execute({
      query: "message",
      directory: tempDir,
      limit: 10,
      max_content_bytes: 17,
      mode: "hybrid",
      includeCallContext: false,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as {
        results: { content: string; content_truncated?: boolean }[];
        retrieval: {
          content_limit_bytes: number;
          content_truncated_count: number;
        };
      };
      expect(data.results[0]?.content_truncated).toBe(true);
      expect(Buffer.byteLength(data.results[0]?.content ?? "", "utf8")).toBe(
        17,
      );
      expect(data.retrieval).toEqual({
        content_limit_bytes: 17,
        content_truncated_count: 1,
        query_kind: "identifier",
        reranker: "lexical",
        candidates_considered: 1,
        duplicates_removed: 0,
        min_confidence: 0,
        abstained: false,
        neighbor_window: 0,
        neighbors_added: 0,
        neighbor_candidates_considered: 0,
        neighbors_truncated: false,
      });
    }
  });

  test("returns error when index does not exist", async () => {
    mockExists.mockReturnValue(false);

    const result = await execute({
      query: "test query",
      directory: tempDir,
      limit: 10,
      mode: "hybrid",
      includeCallContext: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No index found");
  });

  test("returns error when Ollama health check fails", async () => {
    mockHealthCheck.mockResolvedValue({
      ok: false,
      error: "Ollama not running",
    });

    const result = await execute({
      query: "test query",
      directory: tempDir,
      limit: 10,
      mode: "hybrid",
      includeCallContext: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Ollama not running");
  });

  test("returns error when Ollama health check fails without message", async () => {
    mockHealthCheck.mockResolvedValue({ ok: false });

    const result = await execute({
      query: "test query",
      directory: tempDir,
      limit: 10,
      mode: "hybrid",
      includeCallContext: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Ollama is not available");
  });

  test("filters results by threshold in vector mode", async () => {
    mockSearchHybrid.mockResolvedValue([
      {
        chunk: {
          id: "1",
          content: "a",
          filePath: "/a.ts",
          language: "typescript",
          startLine: 1,
          endLine: 1,
        },
        score: 0.3,
      },
      {
        chunk: {
          id: "2",
          content: "b",
          filePath: "/b.ts",
          language: "typescript",
          startLine: 1,
          endLine: 1,
        },
        score: 0.8,
      },
    ]);

    const result = await execute({
      query: "test",
      directory: tempDir,
      limit: 10,
      threshold: 0.5,
      mode: "vector",
      includeCallContext: false,
    });

    expect(result.success).toBe(true);
    const data = result.data as { resultsCount: number };
    expect(data.resultsCount).toBe(1);
  });

  test("does not filter by threshold in hybrid mode", async () => {
    mockSearchHybrid.mockResolvedValue([
      {
        chunk: {
          id: "1",
          content: "a",
          filePath: "/a.ts",
          language: "typescript",
          startLine: 1,
          endLine: 1,
        },
        score: 0.3,
      },
      {
        chunk: {
          id: "2",
          content: "b",
          filePath: "/b.ts",
          language: "typescript",
          startLine: 1,
          endLine: 1,
        },
        score: 0.8,
      },
    ]);

    const result = await execute({
      query: "test",
      directory: tempDir,
      limit: 10,
      threshold: 0.5,
      mode: "hybrid",
      includeCallContext: false,
    });

    expect(result.success).toBe(true);
    const data = result.data as { resultsCount: number };
    // Both results should be returned in hybrid mode (threshold ignored)
    expect(data.resultsCount).toBe(2);
  });

  test("returns message when no results found", async () => {
    mockSearchHybrid.mockResolvedValue([]);

    const result = await execute({
      query: "nonexistent code",
      directory: tempDir,
      limit: 10,
      mode: "hybrid",
      includeCallContext: false,
    });

    expect(result.success).toBe(true);
    expect(result.message).toBe("No matching code found");
  });

  test("handles search errors", async () => {
    mockSearchHybrid.mockRejectedValue(new Error("Database error"));

    const result = await execute({
      query: "test query",
      directory: tempDir,
      limit: 10,
      mode: "hybrid",
      includeCallContext: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Search failed");
    expect(result.error).toContain("Database error");
  });

  test("handles non-Error exceptions", async () => {
    mockSearchHybrid.mockRejectedValue("string error");

    const result = await execute({
      query: "test query",
      directory: tempDir,
      limit: 10,
      mode: "hybrid",
      includeCallContext: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Search failed");
    expect(result.error).toContain("string error");
  });

  test("formats results without symbol info", async () => {
    mockSearchHybrid.mockResolvedValue([
      {
        chunk: {
          id: "chunk_1",
          content: "const x = 1;",
          filePath: "/test/file.ts",
          language: "typescript",
          startLine: 1,
          endLine: 1,
        },
        score: 0.5,
      },
    ]);

    const result = await execute({
      query: "test",
      directory: tempDir,
      limit: 10,
      mode: "hybrid",
      includeCallContext: false,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("[typescript]");
    expect(result.message).not.toContain("(symbol:");
  });

  test("filters by language, path prefix, symbol type, and test inclusion", async () => {
    const sourceDir = path.join(tempDir, "src");
    const testDir = path.join(tempDir, "tests");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });
    const sourceFile = path.join(sourceDir, "service.ts");
    const testFile = path.join(testDir, "service.test.ts");
    fs.writeFileSync(sourceFile, "function service() {}\n");
    fs.writeFileSync(testFile, "function serviceTest() {}\n");

    mockSearchHybrid.mockResolvedValue([
      {
        chunk: {
          id: "source",
          content: "function service() {}",
          filePath: sourceFile,
          language: "typescript",
          startLine: 1,
          endLine: 1,
          symbolName: "service",
          symbolType: "function",
        },
        score: 0.2,
      },
      {
        chunk: {
          id: "test",
          content: "function serviceTest() {}",
          filePath: testFile,
          language: "typescript",
          startLine: 1,
          endLine: 1,
          symbolName: "serviceTest",
          symbolType: "function",
        },
        score: 0.1,
      },
    ]);

    const result = await execute({
      query: "service",
      directory: tempDir,
      limit: 10,
      mode: "fts",
      includeCallContext: false,
      path_prefix: "src",
      language: "typescript",
      symbol_type: "function",
      include_tests: false,
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      resultsCount: number;
      filters: { path_prefix?: string; include_tests: boolean };
      results: { filePath: string }[];
    };
    expect(data.resultsCount).toBe(1);
    expect(data.results[0]?.filePath).toBe("src/service.ts");
    expect(data.filters.path_prefix).toBe("src");
    expect(data.filters.include_tests).toBe(false);
    expect(mockSearchHybrid).toHaveBeenCalledWith(
      expect.any(Array),
      "service",
      501,
      { mode: "fts", vectorWeight: 0.5 },
    );
  });

  test("uses fts mode when specified", async () => {
    const result = await execute({
      query: "test query",
      directory: tempDir,
      limit: 10,
      mode: "fts",
      includeCallContext: false,
    });

    expect(result.success).toBe(true);
    expect(mockSearchHybrid).toHaveBeenCalledWith(
      expect.any(Array),
      "test query",
      501,
      { mode: "fts", vectorWeight: 0.5 },
    );
  });

  test("uses vector mode when specified", async () => {
    const result = await execute({
      query: "test query",
      directory: tempDir,
      limit: 10,
      mode: "vector",
      includeCallContext: false,
    });

    expect(result.success).toBe(true);
    expect(mockSearchHybrid).toHaveBeenCalledWith(
      expect.any(Array),
      "test query",
      501,
      { mode: "vector", vectorWeight: 0.5 },
    );
  });

  test("includeCallContext adds callers and callees to results with symbol", async () => {
    // Create a real file so collectFiles returns it and files.map runs
    fs.writeFileSync(path.join(tempDir, "hello.ts"), "function hello() {}");

    mockGetCallContext.mockReturnValue({
      callers: [{ name: "callerFn", filePath: "/caller.ts" }],
      callees: [{ name: "calleeFn", filePath: "/callee.ts" }],
    });

    const result = await execute({
      query: "hello function",
      directory: tempDir,
      limit: 10,
      mode: "hybrid",
      includeCallContext: true,
    });

    expect(result.success).toBe(true);
    interface ResultData {
      results: {
        callContext?: { callers: string[]; callees: string[] };
      }[];
    }
    const data = result.data as ResultData;
    expect(data.results[0]?.callContext).toBeDefined();
    expect(data.results[0]?.callContext?.callers).toContain("callerFn");
    expect(data.results[0]?.callContext?.callees).toContain("calleeFn");
    expect(result.message).toContain("Called by: callerFn");
    expect(result.message).toContain("Calls: calleeFn");
  });

  test("includeCallContext skips results without symbolName", async () => {
    mockSearchHybrid.mockResolvedValue([
      {
        chunk: {
          id: "chunk_no_symbol",
          content: "const x = 1;",
          filePath: path.join(tempDir, "file.ts"),
          language: "typescript",
          startLine: 1,
          endLine: 1,
        },
        score: 0.5,
      },
    ]);

    const result = await execute({
      query: "test",
      directory: tempDir,
      limit: 10,
      mode: "hybrid",
      includeCallContext: true,
    });

    expect(result.success).toBe(true);
    interface ResultData {
      results: { callContext?: unknown }[];
    }
    const data = result.data as ResultData;
    expect(data.results[0]?.callContext).toBeUndefined();
    expect(mockGetCallContext).not.toHaveBeenCalled();
  });

  test("includeCallContext formats more than 3 callers with ellipsis", async () => {
    mockGetCallContext.mockReturnValue({
      callers: [
        { name: "caller1" },
        { name: "caller2" },
        { name: "caller3" },
        { name: "caller4" },
      ],
      callees: [],
    });

    const result = await execute({
      query: "hello function",
      directory: tempDir,
      limit: 10,
      mode: "hybrid",
      includeCallContext: true,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("...");
    expect(result.message).toContain("caller1");
  });

  test("includeCallContext with no matching context leaves result unchanged", async () => {
    mockGetCallContext.mockReturnValue(null);

    const result = await execute({
      query: "hello function",
      directory: tempDir,
      limit: 10,
      mode: "hybrid",
      includeCallContext: true,
    });

    expect(result.success).toBe(true);
    interface ResultData {
      results: { callContext?: unknown }[];
    }
    const data = result.data as ResultData;
    expect(data.results[0]?.callContext).toBeUndefined();
  });

  test("returns retrieval v2 parts, confidence, and query classification", async () => {
    mockSearchHybrid.mockResolvedValue([
      {
        chunk: {
          id: "chunk_parts",
          content:
            "// Loads the user profile\nfunction loadProfile() {\n  return profile;\n}",
          filePath: path.join(tempDir, "profile.ts"),
          language: "typescript",
          startLine: 1,
          endLine: 4,
          symbolName: "loadProfile",
          symbolType: "function",
        },
        score: 0.9,
      },
    ]);

    const result = await execute({
      query: "loadProfile",
      directory: tempDir,
      limit: 10,
      mode: "fts",
      includeCallContext: false,
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      retrieval: { query_kind: string; reranker: string };
      results: {
        confidence: number;
        parts: { signature?: string; documentation?: string; body: string };
      }[];
    };
    expect(data.retrieval).toMatchObject({
      query_kind: "mixed",
      reranker: "lexical",
    });
    expect(data.results[0]?.confidence).toBeGreaterThan(0);
    expect(data.results[0]?.parts.documentation).toContain(
      "Loads the user profile",
    );
    expect(data.results[0]?.parts.signature).toContain(
      "function loadProfile()",
    );
    expect(data.results[0]?.parts.body).toContain("return profile");
  });

  test("expands bounded same-file neighbors with provenance metadata", async () => {
    const sourceFile = path.join(tempDir, "src.ts");
    fs.writeFileSync(sourceFile, "const source = true;\n");
    mockSearchHybrid.mockResolvedValue([
      {
        chunk: {
          id: "primary",
          content: "function authenticate() { return true; }",
          filePath: sourceFile,
          language: "typescript",
          startLine: 5,
          endLine: 8,
          symbolName: "authenticate",
          symbolType: "function",
        },
        score: 0.9,
      },
    ]);
    mockGetAdjacentChunks.mockResolvedValue({
      neighbors: [
        {
          result: {
            chunk: {
              id: "before",
              content: "const AUTH_TIMEOUT = 5000;",
              filePath: sourceFile,
              language: "typescript",
              startLine: 1,
              endLine: 3,
            },
            score: 0,
          },
          distance: 1,
        },
        {
          result: {
            chunk: {
              id: "after",
              content: "export function login() {}",
              filePath: sourceFile,
              language: "typescript",
              startLine: 10,
              endLine: 12,
            },
            score: 0,
          },
          distance: 1,
        },
      ],
      candidatesConsidered: 3,
      truncated: false,
    });

    const result = await execute({
      query: "authenticate",
      directory: tempDir,
      limit: 10,
      mode: "fts",
      includeCallContext: false,
      neighbor_window: 1,
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      retrieval: {
        neighbor_window: number;
        neighbors_added: number;
        neighbor_candidates_considered: number;
        neighbors_truncated: boolean;
      };
      results: {
        filePath: string;
        is_neighbor?: boolean;
        neighbor_of?: string;
        neighbor_distance?: number;
      }[];
    };
    expect(mockGetAdjacentChunks).toHaveBeenCalledWith(
      sourceFile,
      "primary",
      1,
    );
    expect(data.retrieval).toMatchObject({
      neighbor_window: 1,
      neighbors_added: 2,
      neighbor_candidates_considered: 3,
      neighbors_truncated: false,
    });
    expect(
      data.results.filter((item) => item.is_neighbor === true),
    ).toHaveLength(2);
    expect(
      data.results.find((item) => item.is_neighbor === true),
    ).toMatchObject({
      filePath: "src.ts",
      neighbor_of: "primary",
      neighbor_distance: 1,
    });
  });

  test("deduplicates identical symbol locations and reports the count", async () => {
    const duplicate = {
      chunk: {
        id: "duplicate",
        content: "function same() {}",
        filePath: path.join(tempDir, "same.ts"),
        language: "typescript",
        startLine: 1,
        endLine: 1,
        symbolName: "same",
        symbolType: "function",
      },
      score: 0.5,
    };
    mockSearchHybrid.mockResolvedValue([
      duplicate,
      { ...duplicate, chunk: { ...duplicate.chunk, id: "duplicate-2" } },
    ]);

    const result = await execute({
      query: "same",
      directory: tempDir,
      limit: 10,
      mode: "fts",
      includeCallContext: false,
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      resultsCount: number;
      retrieval: { duplicates_removed: number };
    };
    expect(data.resultsCount).toBe(1);
    expect(data.retrieval.duplicates_removed).toBe(1);
  });

  test("abstains when an explicit confidence floor is not met", async () => {
    mockSearchHybrid.mockResolvedValue([
      {
        chunk: {
          id: "weak",
          content: "const unrelated = true;",
          filePath: path.join(tempDir, "weak.ts"),
          language: "typescript",
          startLine: 1,
          endLine: 1,
        },
        score: 0.01,
      },
    ]);

    const result = await execute({
      query: "authentication",
      directory: tempDir,
      limit: 10,
      min_confidence: 0.99,
      mode: "fts",
      includeCallContext: false,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("confidence floor");
    const data = result.data as {
      resultsCount: number;
      retrieval: { abstained: boolean; abstention_reason?: string };
    };
    expect(data.resultsCount).toBe(0);
    expect(data.retrieval.abstained).toBe(true);
    expect(data.retrieval.abstention_reason).toContain("0.99");
  });
});
