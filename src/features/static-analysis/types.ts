import type { StaticBackend } from "./schema";

export interface StaticFinding {
  backend: StaticBackend;
  rule_id?: string;
  message?: string;
  file_path?: string;
  start_line?: number;
  end_line?: number;
  start_column?: number;
  end_column?: number;
  severity?: string;
  snippet?: string;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  timedOut: boolean;
  spawnError?: string;
}

export interface StaticAnalysisOutput {
  directory: string;
  backend: StaticBackend;
  enabled: boolean;
  available: boolean;
  executable?: string;
  query_kind: "pattern" | "rules-file" | "codeql-query";
  rule_file?: string;
  findings: StaticFinding[];
  findings_count: number;
  truncated: boolean;
  timed_out: boolean;
  output_truncated: boolean;
  source_is_untrusted: true;
  secrets_redacted: boolean;
  stderr?: string;
  errors: string[];
}
