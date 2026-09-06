/**
 * Language configuration and mapping for Tree-sitter parsers
 * Reads from centralized assets/languages.json
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { getAssetsDir, loadJsonConfig, registerCache } from "@core/utils";

export interface LanguageConfig {
  name: string;
  wasm: string;
  queries: string;
  extensions: string[];
  aliases?: string[];
}

export interface GrammarMetadata {
  asset: string;
  sha256: string;
  bytes: number;
}

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
let languagesCache: Record<string, LanguageConfig> | null = null;
let extensionMapCache: Record<string, LanguageConfig> | null = null;
let configuredLanguageMapCache: Record<string, string> | null = null;
let specialFilenameMapCache: Record<string, string> | null = null;
let binaryExtensionsCache: Set<string> | null = null;
const grammarMetadataCache = new Map<string, GrammarMetadata | undefined>();

function loadConfig(): LanguagesConfig {
  if (configCache) {
    return configCache;
  }

  configCache = loadJsonConfig<LanguagesConfig>("languages.json", {
    treesitter: {},
    fallbackExtensions: {},
    specialFilenames: {},
    binaryExtensions: [],
  });
  return configCache;
}

function buildLanguages(): Record<string, LanguageConfig> {
  if (languagesCache) {
    return languagesCache;
  }

  const config = loadConfig();
  languagesCache = {};

  for (const [name, lang] of Object.entries(config.treesitter)) {
    languagesCache[name] = {
      name,
      wasm: lang.wasm,
      queries: lang.queries,
      extensions: lang.extensions,
      aliases: lang.aliases,
    };

    // Also register aliases
    if (lang.aliases) {
      for (const alias of lang.aliases) {
        languagesCache[alias] = {
          name,
          wasm: lang.wasm,
          queries: lang.queries,
          extensions: lang.extensions,
          aliases: lang.aliases,
        };
      }
    }
  }

  return languagesCache;
}

function buildExtensionMap(): Record<string, LanguageConfig> {
  if (extensionMapCache) {
    return extensionMapCache;
  }

  const languages = buildLanguages();
  extensionMapCache = {};

  for (const config of Object.values(languages)) {
    for (const ext of config.extensions) {
      extensionMapCache[ext] = config;
    }
  }

  return extensionMapCache;
}

/** Get all Tree-sitter supported languages */
export function getLanguages(): Record<string, LanguageConfig> {
  return buildLanguages();
}

/** Get language configuration from file extension */
export function getLanguageFromExtension(
  extension: string,
): LanguageConfig | undefined {
  const ext = extension.startsWith(".") ? extension : `.${extension}`;
  return buildExtensionMap()[ext.toLowerCase()];
}

/** Get language configuration from file path */
export function getLanguageFromPath(
  filePath: string,
): LanguageConfig | undefined {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return buildExtensionMap()[ext];
}

/** Get language configuration by name */
export function getLanguageByName(name: string): LanguageConfig | undefined {
  return buildLanguages()[name.toLowerCase()];
}

/**
 * Return the immutable local identity of a bundled Tree-sitter grammar.
 *
 * The project does not claim upstream semantic version numbers for WASM
 * grammars. The shipped asset name, byte length, and SHA-256 digest are the
 * reproducible revision that actually ran.
 */
export function getGrammarMetadata(
  language: string,
): GrammarMetadata | undefined {
  const config = getLanguageByName(language);
  if (config === undefined) {
    return undefined;
  }
  const cached = grammarMetadataCache.get(config.name);
  if (cached !== undefined || grammarMetadataCache.has(config.name)) {
    return cached;
  }

  const assetPath = join(getAssetsDir(), "wasm", config.wasm);
  if (!existsSync(assetPath)) {
    grammarMetadataCache.set(config.name, undefined);
    return undefined;
  }
  try {
    const bytes = readFileSync(assetPath);
    const metadata: GrammarMetadata = {
      asset: config.wasm,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: statSync(assetPath).size,
    };
    grammarMetadataCache.set(config.name, metadata);
    return metadata;
  } catch {
    grammarMetadataCache.set(config.name, undefined);
    return undefined;
  }
}

/** Check if a language is supported by Tree-sitter */
export function isLanguageSupported(language: string): boolean {
  return language.toLowerCase() in buildLanguages();
}

/** Get all supported language names */
export function getSupportedLanguages(): string[] {
  return Object.keys(loadConfig().treesitter);
}

/** Get all supported file extensions */
export function getSupportedExtensions(): string[] {
  return Object.keys(buildExtensionMap());
}

function getConfiguredLanguageMap(): Record<string, string> {
  if (configuredLanguageMapCache) {
    return configuredLanguageMapCache;
  }

  configuredLanguageMapCache = {};
  for (const [extension, config] of Object.entries(buildExtensionMap())) {
    configuredLanguageMapCache[extension.toLowerCase()] = config.name;
  }
  for (const [extension, language] of Object.entries(
    loadConfig().fallbackExtensions,
  )) {
    configuredLanguageMapCache[extension.toLowerCase()] = language;
  }
  return configuredLanguageMapCache;
}

function getSpecialFilenameMap(): Record<string, string> {
  if (specialFilenameMapCache) {
    return specialFilenameMapCache;
  }

  specialFilenameMapCache = Object.fromEntries(
    Object.entries(loadConfig().specialFilenames).map(([name, language]) => [
      name.toLowerCase(),
      language,
    ]),
  );
  return specialFilenameMapCache;
}

function getBinaryExtensions(): Set<string> {
  binaryExtensionsCache ??= new Set(
    loadConfig().binaryExtensions.map((extension) => extension.toLowerCase()),
  );
  return binaryExtensionsCache;
}

/** Get every text extension that can be indexed by any configured parser. */
export function getIndexableExtensions(): string[] {
  const binaryExtensions = getBinaryExtensions();
  return Object.keys(getConfiguredLanguageMap())
    .filter((extension) => !binaryExtensions.has(extension))
    .sort();
}

/** Get configured extensionless or dot-prefixed filenames. */
export function getIndexableSpecialFilenames(): string[] {
  return Object.keys(getSpecialFilenameMap()).sort();
}

/** Resolve the configured Tree-sitter, fallback, or special-file language. */
export function getConfiguredLanguageFromPath(
  filePath: string,
): string | undefined {
  const filename = basename(filePath).toLowerCase();
  const specialLanguage = getSpecialFilenameMap()[filename];
  if (specialLanguage !== undefined) {
    return specialLanguage;
  }
  if (filename.startsWith("dockerfile.")) {
    return "dockerfile";
  }
  if (filename.startsWith(".env.")) {
    return "env";
  }

  return getConfiguredLanguageMap()[extname(filename).toLowerCase()];
}

/** Check whether a path is configured as indexable text. */
export function isIndexableFile(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  return (
    !getBinaryExtensions().has(extension) &&
    getConfiguredLanguageFromPath(filePath) !== undefined
  );
}

/** Clear caches (for testing) */
export function clearLanguageCache(): void {
  configCache = null;
  languagesCache = null;
  extensionMapCache = null;
  configuredLanguageMapCache = null;
  specialFilenameMapCache = null;
  binaryExtensionsCache = null;
  grammarMetadataCache.clear();
}

// Legacy exports for backward compatibility
export const LANGUAGES = buildLanguages();
export const EXTENSION_MAP = buildExtensionMap();

// Register cache for centralized clearing
registerCache("languages:config", clearLanguageCache);
