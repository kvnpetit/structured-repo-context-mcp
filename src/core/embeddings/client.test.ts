import { describe, expect, test, vi, beforeEach } from "vitest";
import { OllamaClient, createOllamaClient } from "@core/embeddings/client";

// Mock instance methods
const mockEmbed = vi.fn();
const mockList = vi.fn();

// Mock the ollama library
vi.mock("ollama", () => ({
  Ollama: vi.fn().mockImplementation(() => ({
    embed: mockEmbed,
    list: mockList,
  })),
}));

describe("OllamaClient", () => {
  const mockConfig = {
    ollamaBaseUrl: "http://localhost:11434",
    embeddingModel: "nomic-embed-text",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("embed", () => {
    test("returns embedding for single text", async () => {
      const mockEmbedding = [0.1, 0.2, 0.3];
      mockEmbed.mockResolvedValueOnce({ embeddings: [mockEmbedding] });

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
      await expect(client.embed("test")).rejects.toThrow(
        "No embedding returned from Ollama",
      );
    });
  });

  describe("embedBatch", () => {
    test("returns embeddings for multiple texts", async () => {
      const mockEmbeddings = [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ];
      mockEmbed.mockResolvedValueOnce({ embeddings: mockEmbeddings });

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
  });

  describe("createOllamaClient", () => {
    test("creates client with config", () => {
      const client = createOllamaClient(mockConfig);
      expect(client).toBeInstanceOf(OllamaClient);
    });
  });
});
