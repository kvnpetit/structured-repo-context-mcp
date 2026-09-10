import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { withProcessFileLock, writeJsonAtomically } from "@core/utils";

export const HASH_CACHE_FILE = ".src-index-hashes.json";
const INDEX_WRITE_LOCK_FILE = ".src-index-write.lock";
const MAX_HASH_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_HASH_CACHE_ENTRIES = 200_000;

export type HashCache = Record<string, string>;

export interface HashCacheReadResult {
  cache: HashCache;
  exists: boolean;
  valid: boolean;
  error?: string;
}

export function computeContentHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export function hashCachePath(root: string): string {
  return path.join(root, ".src-index", HASH_CACHE_FILE);
}

export function indexWriteLockPath(root: string): string {
  return path.join(root, INDEX_WRITE_LOCK_FILE);
}

function normalizedCachePath(root: string, filePath: string): string | undefined {
  const candidate = path.resolve(root, filePath);
  const relative = path.relative(path.resolve(root), candidate);
  return relative.length > 0 &&
    relative !== "." &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
    ? candidate
    : undefined;
}

function isCacheValue(value: unknown): value is string {
  // Older local caches used short opaque values. They remain readable for
  // compatibility; newly written caches always contain SHA-256 digests.
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._-]+$/u.test(value)
  );
}

function safeCacheEntry(
  root: string,
  filePath: string,
  hash: unknown,
): [string, string] | undefined {
  const normalized = normalizedCachePath(root, filePath);
  return normalized === undefined || !isCacheValue(hash) ? undefined : [normalized, hash];
}

/** Read and validate the bounded incremental-index cache. */
export function readHashCache(root: string): HashCacheReadResult {
  const filePath = hashCachePath(root);
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return {
        cache: {},
        exists: true,
        valid: false,
        error: "Hash cache is not a regular file",
      };
    }
    if (stats.size > MAX_HASH_CACHE_BYTES) {
      return {
        cache: {},
        exists: true,
        valid: false,
        error: "Hash cache exceeds the safety limit",
      };
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        cache: {},
        exists: true,
        valid: false,
        error: "Hash cache must contain an object",
      };
    }
    const entries = Object.entries(parsed);
    if (entries.length > MAX_HASH_CACHE_ENTRIES) {
      return {
        cache: {},
        exists: true,
        valid: false,
        error: "Hash cache contains too many entries",
      };
    }
    const cache: HashCache = {};
    let invalidEntries = 0;
    for (const [filePathValue, hash] of entries) {
      const entry = safeCacheEntry(root, filePathValue, hash);
      if (entry === undefined) {
        invalidEntries += 1;
        continue;
      }
      cache[entry[0]] = entry[1];
    }
    return {
      cache,
      exists: true,
      valid: invalidEntries === 0,
      ...(invalidEntries === 0 ? {} : { error: "Hash cache contains invalid entries" }),
    };
  } catch {
    return {
      cache: {},
      exists: fs.existsSync(filePath),
      valid: false,
      error: "Hash cache is missing or corrupt",
    };
  }
}

/** Persist hashes and any closely-related metadata under the shared index lock. */
export async function writeHashCache(
  root: string,
  cache: HashCache,
  afterWrite?: () => void,
): Promise<void> {
  const sanitized = Object.fromEntries(
    Object.entries(cache)
      .map(([filePath, hash]) => safeCacheEntry(root, filePath, hash))
      .filter((entry): entry is [string, string] => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  if (Object.keys(sanitized).length > MAX_HASH_CACHE_ENTRIES) {
    throw new Error("Hash cache contains too many entries");
  }
  await withProcessFileLock(indexWriteLockPath(root), () => {
    writeJsonAtomically(hashCachePath(root), sanitized);
    afterWrite?.();
  });
}
