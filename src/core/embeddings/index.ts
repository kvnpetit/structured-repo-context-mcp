/**
 * Embeddings module barrel exports
 */

// Types
export type {
  ChunkSymbol,
  CodeChunk,
  EmbeddedChunk,
  EmbeddingConfig,
  EnrichedChunk,
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
  type SearchMode,
  type HybridSearchOptions,
} from "@core/embeddings/store";

// Chunker
export {
  chunkFile,
  chunkFiles,
  detectLanguage,
  shouldIndexFile,
  SUPPORTED_EXTENSIONS,
} from "@core/embeddings/chunker";

// Watcher
export {
  IndexWatcher,
  createIndexWatcher,
  type WatcherOptions,
} from "@core/embeddings/watcher";

// Enricher
export {
  clearASTCache,
  enrichChunk,
  enrichChunks,
  enrichChunksFromFile,
  getASTCacheStats,
} from "@core/embeddings/enricher";

// Reranker
export {
  rerank,
  createReranker,
  type RerankerOptions,
  type RerankedResult,
} from "@core/embeddings/reranker";
