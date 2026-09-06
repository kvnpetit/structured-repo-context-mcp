import type { scanInstructionSignals } from "@core/security";

export type LayerKey =
  "project" | "memory" | "artifacts" | "git" | "repository_map" | "search";
export type ContextDepth = "minimal" | "standard" | "deep";

export interface SearchResultData {
  filePath?: string;
  language?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
  score?: number;
  confidence?: number;
  symbolName?: string;
  symbolType?: string;
  is_neighbor?: boolean;
  neighbor_of?: string;
  neighbor_distance?: number;
}

export interface SearchData {
  results?: SearchResultData[];
  instruction_signals?: ReturnType<typeof scanInstructionSignals>;
}

export interface ProjectData {
  project_name?: string;
  project_kind?: string;
  languages?: { language: string; files: number }[];
  frameworks?: { name: string }[];
  manifests?: { path: string; kind: string }[];
  entrypoints?: string[];
  test_roots?: string[];
  workspaces?: string[];
  truncated?: boolean;
}

export interface MemoryData {
  records?: {
    id: string;
    kind: string;
    title: string;
    body: string;
    tags: string[];
    confidence: number;
    revision_state: "current" | "stale" | "unknown";
  }[];
  revision_summary?: { current: number; stale: number; unknown: number };
  truncated?: boolean;
}

export interface ArtifactData {
  artifacts?: {
    file_path: string;
    kind: string;
    title?: string;
    relevance: number;
    content?: string;
  }[];
  instruction_signals?: ReturnType<typeof scanInstructionSignals>;
  truncated?: boolean;
}

export interface GitData {
  head?: string;
  branch?: string;
  clean?: boolean;
  files?: { path: string; status: string; staged: boolean }[];
  change_analysis?: {
    symbols_detected: number;
    symbol_locations: { file_path: string; name: string; type: string }[];
  };
  truncated?: boolean;
}

export interface LayerStatus {
  enabled: boolean;
  available: boolean;
  items: number;
  allocated_tokens: number;
  emitted_tokens: number;
  truncated: boolean;
  error?: string;
}

export interface ContextSection {
  key: LayerKey;
  title: string;
  content: string;
  weight: number;
  enabled: boolean;
  available: boolean;
  items: number;
  sourceTruncated: boolean;
  error?: string;
}

export interface TaskContextOutput {
  directory: string;
  task: string;
  depth: ContextDepth;
  focus_terms: string[];
  estimated_tokens: number;
  token_budget: number;
  truncated: boolean;
  repository_map: string;
  search: {
    available: boolean;
    results: SearchResultData[];
    error?: string;
  };
  layers: Record<LayerKey, LayerStatus>;
  next_actions: string[];
  context: string;
  warnings: string[];
  source_is_untrusted: true;
  instruction_signals: ReturnType<typeof scanInstructionSignals>;
}
