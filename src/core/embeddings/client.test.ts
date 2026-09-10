import { describe, expect, test, vi, beforeEach, type Mock } from "vitest";
import {
  LexicalEmbeddingClient,
  OllamaClient,
  createLexicalEmbeddingClient,
  createOllamaClient,
  validateEmbeddingBatch,
} from "@core/embeddings/client";
import { Ollama } from "ollama";

// Mock the ollama library
vi.mock("ollama", () => ({ Ollama: vi.fn() }));

describe("OllamaClient", () => {
  const mockConfig = {
    ollamaBaseUrl: "http://localhost:11434",
    embeddingModel: "nomic-embed-text",
  };

  let mockEmbed: Mock;
  let mockList: Mock;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mocks for each test
    mockEmbed = vi.fn();
    mockList = vi.fn();

    // Use regular function (not arrow) so it can be used as constructor with `new`
    vi.mocked(Ollama).mockImplementation(function (this: Ollama) {
      this.embed = mockEmbed;
      this.list = mockList;
      return this;
    });
  });

  describe("embed", () => {
    test("returns embedding for single text", async () => {
      const mockEmbedding = [0.1, 0.2, 0.3];
      mockEmbed.mockResolvedValueOnce({
        embeddings: [mockEmbedding],
      });

      const client = new OllamaClient(mockConfig);
      const result = await client.embed("test text");

      expect(result).toEqual(mockEmbedding);
      expect(mockEmbed).toHaveBeenCalledWith({
        model: "nomic-embed-text",
        input: "test text",
      });
    });

    test("throws error when no embedding returned", async () => {
      mockEmbed.mockResolvedValueOnce({ embeddings: [] });

      const client = new OllamaClient(mockConfig);
      await expect(client.embed("test")).rejects.toThrow("No embedding returned from Ollama");
    });
  });

  describe("embedBatch", () => {
    test("returns embeddings for multiple texts", async () => {
      const mockEmbeddings = [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ];
      mockEmbed.mockResolvedValueOnce({
        embeddings: mockEmbeddings,
      });

      const client = new OllamaClient(mockConfig);
      const result = await client.embedBatch(["text1", "text2"]);

      expect(result).toEqual(mockEmbeddings);
      expect(mockEmbed).toHaveBeenCalledWith({
        model: "nomic-embed-text",
        input: ["text1", "text2"],
      });
    });
  });

  describe("healthCheck", () => {
    test("returns ok when model is available", async () => {
      mockList.mockResolvedValueOnce({
        models: [{ name: "nomic-embed-text:latest" }],
      });

      const client = new OllamaClient(mockConfig);
      const result = await client.healthCheck();

      expect(result).toEqual({ ok: true });
    });

    test("returns error when model not found", async () => {
      mockList.mockResolvedValueOnce({
        models: [{ name: "other-model" }],
      });

      const client = new OllamaClient(mockConfig);
      const result = await client.healthCheck();

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Model "nomic-embed-text" not found');
    });

    test("returns error on connection failure", async () => {
      mockList.mockRejectedValueOnce(new Error("Connection refused"));

      const client = new OllamaClient(mockConfig);
      const result = await client.healthCheck();

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Cannot connect to Ollama");
    });

    test("handles non-Error thrown value", async () => {
      mockList.mockRejectedValueOnce("string error message");

      const client = new OllamaClient(mockConfig);
      const result = await client.healthCheck();

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Cannot connect to Ollama");
      expect(result.error).toContain("string error message");
    });

    test("handles exact model name match", async () => {
      mockList.mockResolvedValueOnce({
        models: [{ name: "nomic-embed-text" }],
      });

      const client = new OllamaClient(mockConfig);
      const result = await client.healthCheck();

      expect(result.ok).toBe(true);
    });
  });

  describe("createOllamaClient", () => {
    test("creates client with config", () => {
      const client = createOllamaClient(mockConfig);
      expect(client).toBeInstanceOf(OllamaClient);
    });
  });
});

describe("validateEmbeddingBatch", () => {
  test("accepts a complete finite batch", () => {
    expect(() => {
      validateEmbeddingBatch(
        [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
        2,
        2,
      );
    }).not.toThrow();
  });

  test("rejects missing or malformed embeddings", () => {
    expect(() => {
      validateEmbeddingBatch([[0.1, 0.2]], 2, 2);
    }).toThrow("1 embeddings for 2 inputs");
    expect(() => {
      validateEmbeddingBatch([[0.1]], 1, 2);
    }).toThrow("expected 2 finite dimensions");
    expect(() => {
      validateEmbeddingBatch([[Number.NaN, 0.2]], 1, 2);
    }).toThrow("Invalid embedding");
  });
});

describe("LexicalEmbeddingClient", () => {
  test("provides deterministic normalized local vectors without Ollama", async () => {
    const client = createLexicalEmbeddingClient(8);
    const first = await client.embed("UserService handles user sessions");
    const second = await client.embed("UserService handles user sessions");

    expect(client).toBeInstanceOf(LexicalEmbeddingClient);
    expect(first).toEqual(second);
    expect(first).toHaveLength(8);
    expect(first.every(Number.isFinite)).toBe(true);
    expect(Math.sqrt(first.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1);
    expect(await client.embedBatch(["a", "b"])).toHaveLength(2);
    expect(await client.healthCheck()).toEqual({ ok: true });
  });
});
