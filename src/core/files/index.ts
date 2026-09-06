/**
 * Shared file collection utilities
 *
 * Provides createIgnoreFilter and collectFiles used across features
 * to avoid duplication and ensure consistent behaviour.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import ignore, { type Ignore } from "ignore";

import { shouldIndexFile } from "@core/embeddings/chunker";
import { getMaxFileBytes } from "@core/security";

export type { Ignore };

/** Patterns always excluded regardless of .gitignore */
const DEFAULT_EXCLUSIONS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".src-index",
];

const SENSITIVE_FILE_PATTERNS = [
  /^\.env(?:\..*)?$/iu,
  /^(?:credentials?|secrets?)(?:\.(?:json|ya?ml|toml|ini|txt|env|config))?$/iu,
  /(?:^|[._-])(?:id_rsa|id_ed25519)(?:[._-]|$)/iu,
  /\.(?:pem|key|p12|pfx|kdbx)$/iu,
];

export function isSensitiveFileName(name: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Create an ignore filter combining default exclusions, .gitignore, and extra patterns
 */
export function createIgnoreFilter(
  baseDir: string,
  extraPatterns: string[] = [],
): Ignore {
  const ig = ignore();
  ig.add(DEFAULT_EXCLUSIONS);

  const gitignorePath = path.join(baseDir, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    try {
      const content = fs.readFileSync(gitignorePath, "utf-8");
      ig.add(content);
    } catch {
      // Ignore read errors — .gitignore is optional
    }
  }

  if (extraPatterns.length > 0) {
    ig.add(extraPatterns);
  }

  return ig;
}

/**
 * Check if a file/folder name is hidden (starts with a dot)
 */
export function isHidden(name: string): boolean {
  return name.startsWith(".");
}

/**
 * Recursively collect all indexable files from a directory,
 * respecting ignore rules and skipping hidden entries.
 */
export function collectFiles(
  dir: string,
  ig: Ignore,
  baseDir: string,
): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (
      isHidden(entry.name) &&
      (entry.isDirectory() || !shouldIndexFile(entry.name))
    ) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

    if (ig.ignores(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, ig, baseDir));
    } else if (
      entry.isFile() &&
      !isSensitiveFileName(entry.name) &&
      shouldIndexFile(entry.name) &&
      fs.statSync(fullPath).size <= getMaxFileBytes()
    ) {
      files.push(fullPath);
    }
  }

  return files;
}
