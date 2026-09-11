import type { Position } from "@core/ast/types";
import type { LspOperation } from "@core/navigation/lsp";
import type { scanInstructionSignals } from "@core/security";

import type { backendValues } from "./schema";

export interface NavigationLocation {
  file_path: string;
  start: Position;
  end: Position;
  snippet?: string;
}

export interface NavigationDiagnostic {
  message: string;
  start: Position;
  end: Position;
  severity?: string;
  code?: string | number;
  source?: string;
}

export interface SemanticNavigationOutput {
  operation: LspOperation;
  requested_backend: (typeof backendValues)[number];
  backend_used: "lsp" | "scip" | "treesitter";
  lsp_server?: { id: string; command: string };
  file_path: string;
  language: string;
  source_revision?: string;
  position: { line: number; column: number };
  symbol?: {
    name: string;
    type: string;
    signature?: string;
  };
  locations: NavigationLocation[];
  hover?: { contents: string; range?: { start: Position; end: Position } };
  diagnostics?: NavigationDiagnostic[];
  coverage: "precise" | "approximate" | "unavailable";
  confidence: number;
  truncated: boolean;
  external_locations_ignored: number;
  source_is_untrusted: true;
  secrets_redacted: boolean;
  instruction_signals?: ReturnType<typeof scanInstructionSignals>;
  warnings: string[];
}

export interface SymbolAtPositionData {
  language?: string;
  found?: boolean;
  symbol?: {
    name?: string;
    type?: string;
    signature?: string;
    documentation?: string;
    source?: string;
  } | null;
}

export interface FindSymbolsData {
  matches?: {
    file_path?: string;
    name?: string;
    start?: Position;
    end?: Position;
    snippet?: string;
  }[];
  truncated?: boolean;
}
