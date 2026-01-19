/**
 * Embeddings module barrel exports
 */

// Types
export type {
  CodeChunk,
  EmbeddedChunk,
  EmbeddingConfig,
  IndexStatus,
  SearchResult,
} from "@core/embeddings/types";

// Ollama client
export { OllamaClient, createOllamaClient } from "@core/embeddings/client";

// Vector store
export {
  VectorStore,
  createVectorStore,
  getIndexPath,
} from "@core/embeddings/store";

// Chunker
export {
  chunkFile,
  chunkFiles,
  detectLanguage,
  shouldIndexFile,
  SUPPORTED_EXTENSIONS,
} from "@core/embeddings/chunker";
