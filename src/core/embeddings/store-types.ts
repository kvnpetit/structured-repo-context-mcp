import type { EmbeddingConfig, SearchResult } from "@core/embeddings/types";

export type VectorStoreConfig = Pick<EmbeddingConfig, "embeddingDimensions"> &
  Partial<
    Pick<
      EmbeddingConfig,
      | "embeddingModel"
      | "embeddingProvider"
      | "defaultChunkSize"
      | "defaultChunkOverlap"
    >
  >;

export type SearchMode = "vector" | "fts" | "hybrid";

export interface HybridSearchOptions {
  mode?: SearchMode;
  vectorWeight?: number;
  rrfK?: number;
}

export interface AdjacentChunkResult {
  result: SearchResult;
  distance: number;
}

export interface AdjacentChunks {
  neighbors: AdjacentChunkResult[];
  candidatesConsidered: number;
  truncated: boolean;
}

export interface IndexMaintenanceStatus {
  tablePresent: boolean;
  tableVersion?: number;
  versionCount: number;
  totalBytes: number;
  rows: number;
  fragmentCount: number;
  smallFragmentCount: number;
  indices: string[];
  manifestPathsV2?: boolean;
  metadataSchemaVersion?: number;
  metadataCompatible: boolean;
  metadataError?: string;
}

export interface IndexOptimizationStats {
  compaction: {
    fragmentsRemoved: number;
    fragmentsAdded: number;
    filesRemoved: number;
    filesAdded: number;
  };
  prune: {
    bytesRemoved: number;
    oldVersionsRemoved: number;
  };
}

export interface LanceDBRow extends Record<string, unknown> {
  id: string;
  content: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  symbolName: string;
  symbolType: string;
  vector: number[];
  _distance?: number;
}
