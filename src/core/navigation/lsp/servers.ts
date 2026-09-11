import * as path from "node:path";

import { getConfiguredLanguageFromPath } from "@core/parser/languages";

import type { LspServerCandidate } from "./types";

const CANDIDATES: readonly LspServerCandidate[] = [
  {
    id: "typescript-language-server",
    languages: new Set(["javascript", "typescript", "tsx", "jsx"]),
    commands: [
      { command: "typescript-language-server", args: ["--stdio"] },
      { command: "typescript-language-server.cmd", args: ["--stdio"] },
    ],
  },
  {
    id: "pyright",
    languages: new Set(["python"]),
    commands: [
      { command: "pyright-langserver", args: ["--stdio"] },
      { command: "pyright-langserver.cmd", args: ["--stdio"] },
    ],
  },
  {
    id: "gopls",
    languages: new Set(["go"]),
    commands: [{ command: "gopls", args: ["serve"] }],
  },
  {
    id: "rust-analyzer",
    languages: new Set(["rust"]),
    commands: [{ command: "rust-analyzer", args: [] }],
  },
  {
    id: "clangd",
    languages: new Set(["c", "cpp"]),
    commands: [{ command: "clangd", args: ["--log=error"] }],
  },
  {
    id: "jdtls",
    languages: new Set(["java"]),
    commands: [{ command: "jdtls", args: [] }],
  },
  {
    id: "solargraph",
    languages: new Set(["ruby"]),
    commands: [{ command: "solargraph", args: ["stdio"] }],
  },
];

export function normalizeLanguage(language: string): string {
  const normalized = language.toLowerCase();
  if (normalized === "typescriptreact") {
    return "tsx";
  }
  if (normalized === "javascriptreact") {
    return "jsx";
  }
  if (normalized === "c_sharp" || normalized === "csharp") {
    return "csharp";
  }
  return normalized;
}

export function languageId(filePath: string, language: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".tsx") {
    return "typescriptreact";
  }
  if (extension === ".jsx") {
    return "javascriptreact";
  }
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") {
    return "typescript";
  }
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return "javascript";
  }
  return language;
}

export function candidateFor(language: string): LspServerCandidate | undefined {
  const normalized = normalizeLanguage(language);
  return CANDIDATES.find((candidate) => candidate.languages.has(normalized));
}

export function detectNavigationLanguage(filePath: string): string {
  return normalizeLanguage(getConfiguredLanguageFromPath(filePath) ?? "unknown");
}
