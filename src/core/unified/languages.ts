import { extname } from "node:path";

import { isTextSplitterLanguage } from "@core/fallback";
import { getLanguageFromPath, isLanguageSupported } from "@core/parser";
import { loadJsonConfig, registerCache } from "@core/utils";

interface LanguagesConfig {
  treesitter: Record<
    string,
    {
      wasm: string;
      queries: string;
      extensions: string[];
      aliases?: string[];
    }
  >;
  fallbackExtensions: Record<string, string>;
  specialFilenames: Record<string, string>;
  binaryExtensions: string[];
}

let configCache: LanguagesConfig | null = null;
let binaryExtensionsCache: Set<string> | null = null;
let extensionToLanguageCache: Record<string, string> | null = null;
let specialFilenamesCache: Record<string, string> | null = null;

function loadConfig(): LanguagesConfig {
  configCache ??= loadJsonConfig<LanguagesConfig>("languages.json", {
    treesitter: {},
    fallbackExtensions: {},
    specialFilenames: {},
    binaryExtensions: [],
  });
  return configCache;
}

export function clearUnifiedCache(): void {
  configCache = null;
  binaryExtensionsCache = null;
  extensionToLanguageCache = null;
  specialFilenamesCache = null;
}

export function isBinaryFile(filePath: string): boolean {
  binaryExtensionsCache ??= new Set(loadConfig().binaryExtensions);
  return binaryExtensionsCache.has(extname(filePath).toLowerCase());
}

export function detectLanguage(filePath: string): string {
  const treeSitterConfig = getLanguageFromPath(filePath);
  if (treeSitterConfig) {
    return treeSitterConfig.name;
  }

  extensionToLanguageCache ??= loadConfig().fallbackExtensions;
  const mappedLanguage =
    extensionToLanguageCache[extname(filePath).toLowerCase()];
  if (mappedLanguage) {
    return mappedLanguage;
  }

  const filename = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  specialFilenamesCache ??= loadConfig().specialFilenames;
  const specialLanguage = specialFilenamesCache[filename];
  if (specialLanguage) {
    return specialLanguage;
  }
  if (filename.startsWith(".env.") || filename === ".env") {
    return "env";
  }
  if (filename.startsWith("dockerfile.") || filename === "dockerfile") {
    return "dockerfile";
  }
  return "text";
}

export function getParsingCapabilities(filePath: string): {
  language: string;
  method: "tree-sitter" | "langchain" | "generic";
  features: string[];
} {
  if (isBinaryFile(filePath)) {
    return { language: "binary", method: "generic", features: [] };
  }
  const language = detectLanguage(filePath);
  if (isLanguageSupported(language)) {
    return {
      language,
      method: "tree-sitter",
      features: [
        "Full AST parsing",
        "Accurate symbol extraction",
        "Syntax highlighting queries",
        "Code navigation",
        "Semantic analysis",
      ],
    };
  }
  if (isTextSplitterLanguage(language)) {
    return {
      language,
      method: "langchain",
      features: [
        "Intelligent text splitting",
        "Language-aware chunking",
        "Basic symbol extraction (regex)",
      ],
    };
  }
  return {
    language,
    method: "generic",
    features: ["Generic text splitting", "Basic symbol extraction (regex)"],
  };
}

export function canParse(filePath: string): boolean {
  return !isBinaryFile(filePath);
}

export function getSupportedLanguagesInfo(): {
  language: string;
  method: "tree-sitter" | "langchain";
  extensions: string[];
}[] {
  const config = loadConfig();
  const result: {
    language: string;
    method: "tree-sitter" | "langchain";
    extensions: string[];
  }[] = Object.entries(config.treesitter).map(([language, value]) => ({
    language,
    method: "tree-sitter",
    extensions: value.extensions,
  }));
  const fallbackExtensions: Record<string, string[]> = {};
  for (const [extension, language] of Object.entries(
    config.fallbackExtensions,
  )) {
    if (!config.treesitter[language]) {
      (fallbackExtensions[language] ??= []).push(extension);
    }
  }
  for (const [language, extensions] of Object.entries(fallbackExtensions)) {
    result.push({ language, method: "langchain", extensions });
  }
  return result;
}

registerCache("unified:config", clearUnifiedCache);
