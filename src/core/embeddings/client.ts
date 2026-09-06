/**
 * Ollama client for generating embeddings
 * Uses the official ollama library
 */

import { Ollama } from "ollama";
import type { EmbeddingConfig } from "@core/embeddings/types";

export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  healthCheck(): Promise<{ ok: boolean; error?: string }>;
}

export function validateEmbeddingBatch(
  embeddings: number[][],
  expectedCount: number,
  expectedDimensions: number,
): void {
  if (embeddings.length !== expectedCount) {
    throw new Error(
      `Ollama returned ${String(embeddings.length)} embeddings for ${String(expectedCount)} inputs`,
    );
  }

  for (const [index, embedding] of embeddings.entries()) {
    if (
      embedding.length !== expectedDimensions ||
      embedding.some((value) => !Number.isFinite(value))
    ) {
      throw new Error(
        `Invalid embedding at index ${String(index)}: expected ${String(expectedDimensions)} finite dimensions, received ${String(embedding.length)}`,
      );
    }
  }
}

export class OllamaClient implements EmbeddingClient {
  private readonly client: Ollama;
  private readonly model: string;

  constructor(
    config: Pick<EmbeddingConfig, "ollamaBaseUrl" | "embeddingModel">,
  ) {
    this.client = new Ollama({ host: config.ollamaBaseUrl });
    this.model = config.embeddingModel;
  }

  /**
   * Generate embeddings for a single text
   */
  async embed(text: string): Promise<number[]> {
    const response = await this.client.embed({
      model: this.model,
      input: text,
    });

    const result = response.embeddings[0];
    if (!result) {
      throw new Error("No embedding returned from Ollama");
    }
    return result;
  }

  /**
   * Generate embeddings for multiple texts in a single request
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embed({
      model: this.model,
      input: texts,
    });

    return response.embeddings;
  }

  /**
   * Check if Ollama is reachable and the model is available
   */
  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await this.client.list();
      const models = response.models;
      const modelExists = models.some(
        (m) => m.name === this.model || m.name.startsWith(`${this.model}:`),
      );

      if (!modelExists) {
        return {
          ok: false,
          error: `Model "${this.model}" not found. Run: ollama pull ${this.model}`,
        };
      }

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Cannot connect to Ollama: ${message}` };
    }
  }
}

/**
 * Deterministic local embedding provider.
 *
 * This is intentionally small and dependency-free: token hashes are projected
 * into a signed vector and normalized. It is not a replacement for a semantic
 * model, but it gives users a useful lexical/structural baseline without a
 * running service or API key and keeps vector-shaped indexes valid.
 */
export class LexicalEmbeddingClient implements EmbeddingClient {
  private readonly dimensions: number;

  constructor(dimensions: number) {
    this.dimensions = Math.max(1, Math.floor(dimensions));
  }

  async embed(text: string): Promise<number[]> {
    await Promise.resolve();
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens =
      text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .match(/[a-z0-9_]+/gu) ?? [];

    for (const token of tokens) {
      let hash = 2166136261;
      for (let index = 0; index < token.length; index++) {
        hash ^= token.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      const slot = (hash >>> 0) % this.dimensions;
      vector[slot] = (vector[slot] ?? 0) + 1;
      const signSlot = ((hash ^ 0x9e3779b9) >>> 0) % this.dimensions;
      vector[signSlot] = (vector[signSlot] ?? 0) - 0.25;
    }

    const norm = Math.sqrt(
      vector.reduce((sum, value) => sum + value * value, 0),
    );
    if (norm > 0) {
      for (let index = 0; index < vector.length; index++) {
        vector[index] = (vector[index] ?? 0) / norm;
      }
    }
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const text of texts) {
      vectors.push(await this.embed(text));
    }
    return vectors;
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    await Promise.resolve();
    return { ok: true };
  }
}

/**
 * Create a new Ollama client with default config
 */
export function createOllamaClient(
  config: Pick<EmbeddingConfig, "ollamaBaseUrl" | "embeddingModel">,
): OllamaClient {
  return new OllamaClient(config);
}

export function createLexicalEmbeddingClient(
  dimensions: number,
): LexicalEmbeddingClient {
  return new LexicalEmbeddingClient(dimensions);
}
