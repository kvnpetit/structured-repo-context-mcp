export type LspOperation =
  | "definition"
  | "references"
  | "implementation"
  | "hover"
  | "type_hierarchy"
  | "diagnostics";

export interface LspLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface LspHover {
  contents: unknown;
  range?: LspLocation["range"];
}

export interface LspDiagnostic {
  message: string;
  range: LspLocation["range"];
  severity?: number;
  code?: string | number;
  source?: string;
}

export interface LspServerDescriptor {
  id: string;
  command: string;
  args: string[];
}

export interface LspRequestOptions {
  root: string;
  filePath: string;
  content: string;
  language: string;
  line: number;
  column: number;
  operation: LspOperation;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type LspResult =
  | { kind: "locations"; locations: LspLocation[]; server: LspServerDescriptor }
  | { kind: "hover"; hover: LspHover | null; server: LspServerDescriptor }
  | {
      kind: "diagnostics";
      diagnostics: LspDiagnostic[];
      server: LspServerDescriptor;
    };

export type LspFailureReason =
  "disabled" | "unsupported_language" | "server_unavailable" | "request_failed";

export type LspAttempt =
  | { ok: true; result: LspResult }
  | { ok: false; reason: LspFailureReason; detail: string };

export interface LspServerCandidate {
  id: string;
  languages: ReadonlySet<string>;
  commands: readonly { command: string; args: string[] }[];
}
