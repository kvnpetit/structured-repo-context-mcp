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
  IndexMetadata,
  SearchResult,
} from "@core/embeddings/types";

// Ollama client
export {
  OllamaClient,
  LexicalEmbeddingClient,
  createOllamaClient,
  createLexicalEmbeddingClient,
  validateEmbeddingBatch,
  type EmbeddingClient,
} from "@core/embeddings/client";

// Vector store
export {
  VectorStore,
  computeSourceFingerprint,
  createVectorStore,
  getIndexPath,
  hasIndexData,
  type AdjacentChunkResult,
  type AdjacentChunks,
  type IndexMaintenanceStatus,
  type IndexOptimizationStats,
  type SearchMode,
  type HybridSearchOptions,
} from "@core/embeddings/store";

// Incremental source-hash cache
export {
  HASH_CACHE_FILE,
  hashCachePath,
  indexWriteLockPath,
  readHashCache,
  writeHashCache,
  type HashCache,
  type HashCacheReadResult,
} from "@core/embeddings/hash-cache";

// Chunker
export {
  chunkFile,
  chunkFiles,
  detectLanguage,
  shouldIndexFile,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_FILENAMES,
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
  type EnrichmentOptions,
} from "@core/embeddings/enricher";

// Cross-file context
export {
  clearCrossFileCache,
  getCrossFileCacheStats,
  resolveCrossFileContext,
  type CrossFileContext,
  type CrossFileOptions,
  type ResolvedImport,
} from "@core/embeddings/crossfile";

// Call graph
export {
  analyzeFileForCallGraph,
  buildCallGraph,
  clearCallGraphCache,
  formatCallContext,
  getCallContext,
  getCallGraphCacheStats,
  type CallGraph,
  type CallGraphNode,
  type FunctionCall,
} from "@core/embeddings/callgraph";
