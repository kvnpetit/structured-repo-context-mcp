import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { EmbeddedChunk } from "@core/embeddings/types";
import { withProcessFileLock } from "@core/utils";

import type { LanceDBRow } from "./store-types";

export const TABLE_NAME = "code_chunks";
export const INDEX_DIR_NAME = ".src-index";
export const INDEX_TABLE_DIR_NAME = `${TABLE_NAME}.lance`;
export const INDEX_METADATA_FILE = "metadata.json";
export const INDEX_SCHEMA_VERSION = 1;

const indexWriteLocks = new Map<string, Promise<void>>();

export function computeSourceFingerprint(hashes: Record<string, string>): string {
  const canonical = Object.entries(hashes)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([filePath, hash]) => `${filePath}\0${hash}`)
    .join("\n");
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

export async function withIndexWriteLock<T>(
  indexPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = normalizeFilePath(indexPath);
  const previous = indexWriteLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous
    .catch(() => undefined)
    .then(async () => {
      await gate;
    });
  indexWriteLocks.set(key, queued);

  await previous.catch(() => undefined);
  try {
    return await withProcessFileLock(
      path.join(path.dirname(indexPath), ".src-index-write.lock"),
      operation,
    );
  } finally {
    release();
    if (indexWriteLocks.get(key) === queued) {
      indexWriteLocks.delete(key);
    }
  }
}

export function toLanceRecords(chunks: EmbeddedChunk[]): LanceDBRow[] {
  return chunks.map((chunk) => ({
    id: chunk.id,
    content: chunk.content,
    filePath: chunk.filePath,
    language: chunk.language,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    symbolName: chunk.symbolName ?? "",
    symbolType: chunk.symbolType ?? "",
    vector: chunk.vector,
  }));
}

export function validateAbsoluteFilePath(filePath: string, operation: string): void {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`${operation} requires an absolute path, got: ${filePath}`);
  }
}

export function normalizeFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function hasIndexData(directory: string): boolean {
  return fs.existsSync(path.join(directory, INDEX_DIR_NAME, INDEX_TABLE_DIR_NAME));
}

export function chunkIdPredicate(chunkIds: string[]): string {
  const values = chunkIds.map((id) => `'${id.replace(/'/g, "''")}'`);
  return `id IN (${values.join(", ")})`;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
