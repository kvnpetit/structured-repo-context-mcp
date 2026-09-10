import fs from "node:fs";

import { hashCachePath, readHashCache, writeHashCache } from "@core/embeddings/hash-cache";
import { computeSourceFingerprint } from "@core/embeddings/store";
import { computeContentHash } from "@core/embeddings/watcher-indexing";
import { logger } from "@utils";

type HashEntries = Record<string, string>;

export class WatcherHashCache {
  private entries: HashEntries = {};

  constructor(
    private readonly directory: string,
    private readonly onPersist: (sourceFingerprint: string) => void,
  ) {
    this.reload();
  }

  reload(): void {
    this.entries = {};
    const loaded = readHashCache(this.directory);
    if (!loaded.exists) {
      return;
    }
    if (!loaded.valid) {
      logger.warn(`Hash cache corrupted, resetting: ${loaded.error ?? "invalid entries"}`);
    }
    this.entries = loaded.cache;
    logger.debug(`Loaded ${String(Object.keys(this.entries).length)} cached hashes`);
  }

  paths(): string[] {
    return Object.keys(this.entries);
  }

  changedHash(filePath: string, content: string): string | undefined {
    const hash = computeContentHash(content);
    return this.entries[filePath] === hash ? undefined : hash;
  }

  set(filePath: string, hash: string): void {
    this.entries[filePath] = hash;
  }

  remove(filePath: string): void {
    const { [filePath]: _, ...rest } = this.entries;
    this.entries = rest;
  }

  async save(): Promise<void> {
    try {
      await writeHashCache(this.directory, this.entries, () => {
        this.onPersist(computeSourceFingerprint(this.entries));
      });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      logger.debug(`Failed to save hash cache: ${normalized.message}`);
    }
  }

  clear(): void {
    this.entries = {};
    const cachePath = hashCachePath(this.directory);
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
    }
  }

  stats(): { cachedFiles: number; cacheSize: number } {
    return {
      cachedFiles: Object.keys(this.entries).length,
      cacheSize: JSON.stringify(this.entries).length,
    };
  }
}
