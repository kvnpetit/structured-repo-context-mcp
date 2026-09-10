import { describe, expect, test, vi } from "vitest";
import { config, ENV, getEmbeddingConfig, getEnrichmentConfig, getMaxResultBytes } from "@config";

describe("Config", () => {
  test("config has required fields", () => {
    expect(config.name).toBe("src-mcp");
    expect(config.fullName).toBe("SRC (Structured Repo Context)");
    expect(config.version).toBeDefined();
    expect(config.description).toBeDefined();
  });

  test("config.version is valid semver format", () => {
    expect(config.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("ENV", () => {
  test("ENV has required fields", () => {
    expect(typeof ENV.isDev).toBe("boolean");
    expect(typeof ENV.isProd).toBe("boolean");
    expect(typeof ENV.logLevel).toBe("string");
  });

  test("ENV.logLevel defaults to info", () => {
    expect(ENV.logLevel).toBe("info");
  });

  test("bounds the MCP result-size configuration", () => {
    expect(getMaxResultBytes()).toBe(2 * 1024 * 1024);

    vi.stubEnv("SRC_MAX_RESULT_BYTES", "4096");
    expect(getMaxResultBytes()).toBe(4096);

    vi.stubEnv("SRC_MAX_RESULT_BYTES", "999999999");
    expect(getMaxResultBytes()).toBe(2 * 1024 * 1024);

    vi.unstubAllEnvs();
  });

  test("normalizes unsafe embedding and enrichment settings", () => {
    const embedding = getEmbeddingConfig({
      EMBEDDING_DIMENSIONS: "-1",
      CHUNK_SIZE: "100",
      CHUNK_OVERLAP: "999999",
      EMBEDDING_BATCH_SIZE: "0",
    });
    expect(embedding.embeddingDimensions).toBe(768);
    expect(embedding.defaultChunkSize).toBe(100);
    expect(embedding.defaultChunkOverlap).toBe(99);
    expect(embedding.batchSize).toBe(10);

    const enrichment = getEnrichmentConfig({
      ENRICHMENT_MAX_IMPORTS: "-4",
      ENRICHMENT_MAX_SYMBOLS_PER_IMPORT: "9999",
    });
    expect(enrichment.maxImportsToResolve).toBe(10);
    expect(enrichment.maxSymbolsPerImport).toBe(5);
  });

  test("keeps Ollama embedding endpoints on loopback", () => {
    expect(getEmbeddingConfig({ OLLAMA_BASE_URL: "http://127.0.0.1:11434/" }).ollamaBaseUrl).toBe(
      "http://127.0.0.1:11434",
    );
    expect(
      getEmbeddingConfig({ OLLAMA_BASE_URL: "http://192.168.1.100:11434" }).ollamaBaseUrl,
    ).toBe("http://localhost:11434");
    expect(getEmbeddingConfig({ OLLAMA_BASE_URL: "https://example.com" }).ollamaBaseUrl).toBe(
      "http://localhost:11434",
    );
  });
});
