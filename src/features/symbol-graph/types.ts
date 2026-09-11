import type { Import, Symbol } from "@core/ast/types";

export interface ParsedFile {
  absolutePath: string;
  relativePath: string;
  language: string;
  content: string;
  symbols: Symbol[];
  imports: Import[];
  isTest: boolean;
}

export interface ImportBinding {
  file: ParsedFile;
  imported: string;
}

export interface SignalMatch {
  kind: "route" | "event" | "dependency";
  name: string;
  operation?: string;
  index: number;
  evidence: string;
}
