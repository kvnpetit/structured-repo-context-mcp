/**
 * Embedding types for Ollama + LanceDB integration
 */

/**
 * A chunk of code with metadata
 */
export interface CodeChunk {
  id: string;
  content: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  symbolType?: string;
}

/**
 * A chunk with its embedding vector
 */
export interface EmbeddedChunk extends CodeChunk {
  vector: number[];
}

/**
 * Search result from LanceDB
 */
export interface SearchResult {
  chunk: CodeChunk;
  score: number;
}

/**
 * Index status information
 */
export interface IndexStatus {
  directory: string;
  indexPath: string;
  exists: boolean;
  totalChunks: number;
  totalFiles: number;
  languages: Record<string, number>;
  lastUpdated?: Date;
}

/**
 * Embedding configuration
 */
export interface EmbeddingConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  defaultChunkSize: number;
  defaultChunkOverlap: number;
  batchSize: number;
}
