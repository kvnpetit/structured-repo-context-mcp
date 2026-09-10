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

export interface FileCollectionOptions {
  /** Maximum number of files returned (default 100,000). */
  maxFiles?: number;
  /** Maximum aggregate bytes represented by returned files (default 512 MiB). */
  maxBytes?: number;
  /** Maximum directory depth below baseDir (default 128). */
  maxDepth?: number;
  /** Abort a traversal before another filesystem operation. */
  signal?: AbortSignal;
}

const DEFAULT_MAX_COLLECTION_FILES = 100_000;
const DEFAULT_MAX_COLLECTION_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_COLLECTION_DEPTH = 128;

/** Patterns always excluded regardless of .gitignore */
const DEFAULT_EXCLUSIONS = ["node_modules", ".git", "dist", "build", ".src-index"];

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
export function createIgnoreFilter(baseDir: string, extraPatterns: string[] = []): Ignore {
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
  options: FileCollectionOptions = {},
): string[] {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_COLLECTION_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_COLLECTION_BYTES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_COLLECTION_DEPTH;
  if (
    !Number.isSafeInteger(maxFiles) ||
    maxFiles <= 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 0
  ) {
    throw new Error("Invalid file collection safety budget");
  }

  const files: string[] = [];
  let totalBytes = 0;

  const visit = (current: string, depth: number): void => {
    if (options.signal?.aborted) {
      throw new Error("File collection cancelled");
    }
    if (depth > maxDepth) {
      throw new Error(`File collection exceeded the ${String(maxDepth)}-level depth limit`);
    }
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      if (options.signal?.aborted) {
        throw new Error("File collection cancelled");
      }

      if (isHidden(entry.name) && (entry.isDirectory() || !shouldIndexFile(entry.name))) {
        continue;
      }

      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

      if (ig.ignores(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || isSensitiveFileName(entry.name) || !shouldIndexFile(entry.name)) {
        continue;
      }
      const size = fs.statSync(fullPath).size;
      if (size > getMaxFileBytes()) {
        continue;
      }
      if (files.length >= maxFiles) {
        throw new Error(`File collection exceeded the ${String(maxFiles)}-file limit`);
      }
      if (totalBytes > maxBytes - size) {
        throw new Error(`File collection exceeded the ${String(maxBytes)}-byte limit`);
      }
      files.push(fullPath);
      totalBytes += size;
    }
  };

  visit(path.resolve(dir), 0);
  return files;
}
