import type { AdjacentChunks, SearchResult } from "@core/embeddings";
import type {
  mergeInstructionSignals,
  scanInstructionSignals,
} from "@core/security";

export interface CallContextInfo {
  callers: string[];
  callees: string[];
}

export interface FormattedResult {
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  confidence: number;
  content_truncated?: boolean;
  is_neighbor?: boolean;
  neighbor_of?: string;
  neighbor_distance?: number;
  parts: {
    signature?: string;
    documentation?: string;
    body: string;
  };
  symbolName?: string;
  symbolType?: string;
  callContext?: CallContextInfo;
}

export interface SearchCandidate extends SearchResult {
  isNeighbor?: boolean;
  neighborOf?: string;
  neighborDistance?: number;
}

export type QueryKind = "identifier" | "concept" | "mixed";

export interface SearchFilters {
  language?: string;
  path_prefix?: string;
  symbol_type?: string;
  include_tests: boolean;
}

export interface NeighborExpansion {
  results: SearchCandidate[];
  candidatesConsidered: number;
  added: number;
  duplicatesRemoved: number;
  truncated: boolean;
}

export interface AdjacentChunkStore {
  getAdjacentChunks?: (
    filePath: string,
    chunkId: string,
    window: number,
  ) => Promise<AdjacentChunks>;
}

export interface FormattedSearchResults {
  results: FormattedResult[];
  redacted: boolean;
  contentTruncatedCount: number;
  instruction_signals: ReturnType<typeof mergeInstructionSignals>;
}

export interface SearchOutput {
  query: string;
  directory: string;
  resultsCount: number;
  truncated: boolean;
  cursor_offset: number;
  next_cursor?: string;
  retrieval: {
    query_kind: QueryKind;
    reranker: "none" | "lexical" | "code";
    candidates_considered: number;
    duplicates_removed: number;
    min_confidence: number;
    abstained: boolean;
    abstention_reason?: string;
    content_limit_bytes: number;
    content_truncated_count: number;
    neighbor_window: number;
    neighbors_added: number;
    neighbor_candidates_considered: number;
    neighbors_truncated: boolean;
  };
  filters: SearchFilters;
  index: {
    schema_version?: number;
    embedding_provider?: string;
    embedding_model?: string;
    embedding_dimensions?: number;
    updated_at?: string;
    source_fingerprint?: string;
  };
  source_is_untrusted: true;
  secrets_redacted: boolean;
  instruction_signals: ReturnType<typeof scanInstructionSignals>;
  results: FormattedResult[];
}
