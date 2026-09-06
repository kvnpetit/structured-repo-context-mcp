export type ChangeStatus =
  "added" | "modified" | "deleted" | "renamed" | "unknown";

export interface StatusEntry {
  path: string;
  index: string;
  worktree: string;
  status: ChangeStatus;
  staged: boolean;
  untracked: boolean;
}

export interface HistoryEntry {
  commit: string;
  author: string;
  date: string;
  subject: string;
}

export interface HotspotEntry {
  path: string;
  commits: number;
  additions: number;
  deletions: number;
  binary_changes: number;
  churn: number;
  last_commit: string;
  last_date: string;
}

export interface HotspotAnalysis {
  commits_analyzed: number;
  files: HotspotEntry[];
  truncated: boolean;
}

export interface RevisionChange {
  path: string;
  status: ChangeStatus;
  old_path?: string;
}

export interface RevisionComparison {
  from: string;
  to: string;
  from_commit: string;
  to_commit: string;
  files_changed: number;
  files: RevisionChange[];
  truncated: boolean;
}

export interface BlameEntry {
  line: number;
  commit: string;
  author?: string;
  date?: string;
  summary?: string;
}

export interface ChangeSymbolLocation {
  file_path: string;
  status: string;
  name: string;
  type: string;
  start: { line: number; column: number; offset: number };
  end: { line: number; column: number; offset: number };
}

export interface GitContextOutput {
  directory: string;
  repository_root: string;
  git_available: true;
  head?: string;
  branch?: string;
  clean?: boolean;
  files: StatusEntry[];
  diff: { text: string; bytes: number; truncated: boolean };
  history: HistoryEntry[];
  hotspots?: HotspotAnalysis;
  revision_compare?: RevisionComparison;
  blame: Record<string, BlameEntry[]>;
  codeowners: { path?: string; lines: string[] };
  change_analysis: {
    files_changed: number;
    files_analyzed: number;
    symbols_detected: number;
    files_truncated: boolean;
    symbols_truncated: boolean;
    symbol_locations: ChangeSymbolLocation[];
    errors: string[];
  };
  truncated: boolean;
  source_is_untrusted: true;
  secrets_redacted: boolean;
  errors: string[];
}
