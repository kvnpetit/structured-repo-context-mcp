import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type Mock,
} from "vitest";
import { rerank, createReranker } from "@core/embeddings/reranker";
import type { SearchResult } from "@core/embeddings/types";

// Mock logger
vi.mock("@utils", () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fetch
const mockFetch = vi.fn() as Mock;
global.fetch = mockFetch;

describe("reranker", () => {
  const mockOptions = {
    ollamaBaseUrl: "http://localhost:11434",
    model: "llama3.2",
    maxResults: 10,
    timeout: 5000,
  };

  const createMockResult = (
    id: string,
    content: string,
    score: number,
  ): SearchResult => ({
    chunk: {
      id,
      content,
      filePath: `/test/${id}.ts`,
      language: "typescript",
      startLine: 1,
      endLine: 5,
    },
    score,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("rerank", () => {
    test("returns empty array for empty results", async () => {
      const results = await rerank("test query", [], mockOptions);
      expect(results).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("re-ranks results using LLM scores", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ response: "8" }),
      });

      const results = [
        createMockResult("a", "function handleError() {}", 0.5),
        createMockResult("b", "const x = 1;", 0.3),
      ];

      const reranked = await rerank("error handling", results, mockOptions);

      expect(reranked).toHaveLength(2);
      expect(reranked[0]?.rerankScore).toBe(8);
      expect(reranked[0]?.originalScore).toBe(0.5);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test("sorts results by rerank score (higher is better)", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ response: "3" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ response: "9" }),
        });

      const results = [
        createMockResult("a", "irrelevant code", 0.9),
        createMockResult("b", "highly relevant error handler", 0.1),
      ];

      const reranked = await rerank("error", results, mockOptions);

      expect(reranked[0]?.chunk.id).toBe("b"); // Higher rerank score
      expect(reranked[0]?.rerankScore).toBe(9);
      expect(reranked[1]?.chunk.id).toBe("a");
      expect(reranked[1]?.rerankScore).toBe(3);
    });

    test("limits results to maxResults", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ response: "5" }),
      });

      const results = Array.from({ length: 20 }, (_, i) =>
        createMockResult(`item${String(i)}`, `content ${String(i)}`, 0.5),
      );

      const reranked = await rerank("query", results, {
        ...mockOptions,
        maxResults: 5,
      });

      expect(reranked).toHaveLength(5);
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    test("handles failed fetch gracefully", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        statusText: "Internal Server Error",
      });

      const results = [createMockResult("a", "content", 0.5)];
      const reranked = await rerank("query", results, mockOptions);

      expect(reranked).toHaveLength(1);
      expect(reranked[0]?.rerankScore).toBe(5); // Default score
    });

    test("handles fetch errors gracefully", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const results = [createMockResult("a", "content", 0.5)];
      const reranked = await rerank("query", results, mockOptions);

      expect(reranked).toHaveLength(1);
      expect(reranked[0]?.rerankScore).toBe(5); // Default score
    });

    test("parses various score formats", async () => {
      // Test different response formats
      const responses = [
        { response: "7", expected: 7 },
        { response: "Score: 8.5", expected: 8.5 },
        { response: "The relevance is 6", expected: 6 },
        { response: "75", expected: 7.5 }, // Normalized from 0-100
        { response: "invalid", expected: 5 }, // Default
      ];

      for (const { response } of responses) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ response }),
        });
      }

      const results = responses.map((_, i) =>
        createMockResult(`item${String(i)}`, "content", 0.5),
      );

      const reranked = await rerank("query", results, mockOptions);

      expect(reranked).toHaveLength(5);
      // Results are sorted by score, so check that scores are parsed correctly
      const scores = reranked.map((r) => r.rerankScore).sort((a, b) => b - a);
      expect(scores).toContain(8.5);
      expect(scores).toContain(7.5);
      expect(scores).toContain(7);
      expect(scores).toContain(6);
      expect(scores).toContain(5);
    });

    test("uses default model when not specified", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ response: "5" }),
      });

      const results = [createMockResult("a", "content", 0.5)];
      await rerank("query", results, { ollamaBaseUrl: "http://localhost:11434" });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"model":"llama3.2"'),
        }),
      );
    });

    test("processes results in batches", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ response: "5" }),
      });

      // Create 12 results (will need 3 batches of 5)
      const results = Array.from({ length: 12 }, (_, i) =>
        createMockResult(`item${String(i)}`, `content ${String(i)}`, 0.5),
      );

      await rerank("query", results, { ...mockOptions, maxResults: 12 });

      // All 12 should be processed
      expect(mockFetch).toHaveBeenCalledTimes(12);
    });
  });

  describe("createReranker", () => {
    test("creates a reranker function with preset options", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ response: "7" }),
      });

      const rerankFn = createReranker(mockOptions);
      const results = [createMockResult("a", "content", 0.5)];

      const reranked = await rerankFn("query", results);

      expect(reranked).toHaveLength(1);
      expect(reranked[0]?.rerankScore).toBe(7);
    });
  });
});
