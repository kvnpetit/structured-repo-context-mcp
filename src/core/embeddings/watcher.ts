/**
 * File watcher for automatic index updates
 *
 * Features:
 * - SHA-256 hash comparison to detect real content changes
 * - Debounce (5s default) to handle rapid changes
 * - Persistent hash cache to avoid unnecessary re-indexing
 * - fast-glob for efficient file scanning
 */

import * as path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type { Ignore } from "ignore";
import type { EmbeddingConfig } from "@core/embeddings/types";
import {
  OllamaClient,
  createLexicalEmbeddingClient,
  type EmbeddingClient,
} from "@core/embeddings/client";
import { VectorStore } from "@core/embeddings/store";
import { shouldIndexFile } from "@core/embeddings/chunker";
import type { EnrichmentOptions } from "@core/embeddings/enricher";
import {
  collectIndexableFiles,
  embedFileContent,
  shouldIndexPath,
} from "@core/embeddings/watcher-indexing";
import { WatcherHashCache } from "@core/embeddings/watcher-cache";
import { createIgnoreFilter } from "@core/files";
import { readPathAliasesCached } from "@core/utils";
import { readSecureTextFile, resolveSecureDirectory } from "@core/security";
import { logger } from "@utils";

/** Default debounce delay in milliseconds */
const DEFAULT_DEBOUNCE_MS = 5000;

export interface WatcherOptions {
  directory: string;
  config: EmbeddingConfig;
  /** Debounce delay in ms (default: 5000) */
  debounceMs?: number;
  onReady?: () => void;
  onError?: (error: Error) => void;
  onIndexed?: (filePath: string) => void;
  onRemoved?: (filePath: string) => void;
}

interface PendingChange {
  type: "add" | "change" | "unlink";
  filePath: string;
  timer: ReturnType<typeof setTimeout>;
}

export class IndexWatcher {
  private readonly directory: string;
  private readonly config: EmbeddingConfig;
  private readonly debounceMs: number;
  private readonly embeddingClient: EmbeddingClient;
  private readonly vectorStore: VectorStore;
  private readonly enrichmentOptions: EnrichmentOptions;
  private watcher: FSWatcher | null = null;
  private ig: Ignore;
  private isProcessing = false;
  private readonly hashCache: WatcherHashCache;
  private pendingChanges = new Map<string, PendingChange>();
  private operationQueue: (() => Promise<void>)[] = [];

  private readonly onReady?: () => void;
  private readonly onError?: (error: Error) => void;
  private readonly onIndexed?: (filePath: string) => void;
  private readonly onRemoved?: (filePath: string) => void;

  constructor(options: WatcherOptions) {
    const secureDirectory = resolveSecureDirectory(options.directory);
    if (!secureDirectory.ok) {
      throw new Error(secureDirectory.error);
    }
    this.directory = secureDirectory.path;
    this.config = options.config;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.embeddingClient =
      options.config.embeddingProvider === "lexical"
        ? createLexicalEmbeddingClient(options.config.embeddingDimensions)
        : new OllamaClient(options.config);
    this.vectorStore = new VectorStore(this.directory, options.config);
    this.enrichmentOptions = {
      projectRoot: this.directory,
      pathAliases: readPathAliasesCached(this.directory),
      includeCrossFileContext: true,
    };
    this.ig = this.createIgnoreFilter();

    this.onReady = options.onReady;
    this.onError = options.onError;
    this.onIndexed = options.onIndexed;
    this.onRemoved = options.onRemoved;

    this.hashCache = new WatcherHashCache(this.directory, (fingerprint) => {
      const setSourceFingerprint = (
        this.vectorStore as unknown as {
          setSourceFingerprint?: (sourceFingerprint: string) => void;
        }
      ).setSourceFingerprint;
      setSourceFingerprint?.call(this.vectorStore, fingerprint);
    });
  }

  /**
   * Check if file content has changed by comparing hashes
   */
  private getChangedContentHash(
    filePath: string,
    content: string,
  ): string | undefined {
    return this.hashCache.changedHash(filePath, content);
  }

  /**
   * Remove file from hash cache
   */
  private removeFromHashCache(filePath: string): void {
    this.hashCache.remove(filePath);
  }

  /**
   * Create ignore filter from .gitignore
   */
  private createIgnoreFilter(): Ignore {
    return createIgnoreFilter(this.directory);
  }

  /**
   * Check if a file should be indexed
   */
  private shouldIndex(filePath: string): boolean {
    return shouldIndexPath(this.directory, this.ig, filePath);
  }

  /**
   * Schedule a file change with debouncing
   */
  private scheduleChange(
    type: "add" | "change" | "unlink",
    filePath: string,
  ): void {
    const existing = this.pendingChanges.get(filePath);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.pendingChanges.delete(filePath);
      this.queueOperation(async () => this.processChange(type, filePath));
    }, this.debounceMs);

    this.pendingChanges.set(filePath, { type, filePath, timer });

    logger.debug(
      `Scheduled ${type}: ${path.basename(filePath)} (${String(this.debounceMs)}ms)`,
    );
  }

  /**
   * Process a file change after debounce
   */
  private async processChange(
    type: "add" | "change" | "unlink",
    filePath: string,
  ): Promise<void> {
    if (type === "unlink") {
      await this.removeFile(filePath);
    } else {
      await this.indexFile(filePath);
    }
  }

  /**
   * Index a single file
   */
  private async indexFile(filePath: string): Promise<void> {
    if (!this.shouldIndex(filePath)) {
      return;
    }

    try {
      const readResult = readSecureTextFile(filePath, this.directory);
      if (!readResult.ok || readResult.content === undefined) {
        const readError = readResult.ok
          ? "File cannot be read"
          : readResult.error;
        throw new Error(readError);
      }
      const content = readResult.content;

      // Skip if content unchanged
      const newHash = this.getChangedContentHash(filePath, content);
      if (newHash === undefined) {
        logger.debug(`Skipped (unchanged): ${path.basename(filePath)}`);
        return;
      }

      const embeddedChunks = await embedFileContent(
        filePath,
        content,
        this.config,
        this.embeddingClient,
        this.enrichmentOptions,
      );
      if (embeddedChunks.length === 0) {
        await this.vectorStore.replaceFileChunks(filePath, []);
        this.hashCache.set(filePath, newHash);
        await this.hashCache.save();
        logger.debug(`Removed stale chunks: ${path.basename(filePath)}`);
        this.onIndexed?.(filePath);
        return;
      }

      await this.vectorStore.replaceFileChunks(filePath, embeddedChunks);

      this.hashCache.set(filePath, newHash);
      await this.hashCache.save();

      logger.debug(`Indexed: ${path.relative(this.directory, filePath)}`);
      this.onIndexed?.(filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const relativePath = path.relative(this.directory, filePath);
      const error = new Error(`Failed to index ${relativePath}: ${message}`);
      logger.error(error.message);
      this.onError?.(error);
    }
  }

  /**
   * Remove a file from the index
   */
  private async removeFile(filePath: string): Promise<void> {
    try {
      await this.vectorStore.deleteByFilePath(filePath);
      this.removeFromHashCache(filePath);
      await this.hashCache.save();

      logger.debug(`Removed: ${path.relative(this.directory, filePath)}`);
      this.onRemoved?.(filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const relativePath = path.relative(this.directory, filePath);
      const error = new Error(`Failed to remove ${relativePath}: ${message}`);
      logger.error(error.message);
      this.onError?.(error);
    }
  }

  /**
   * Queue an operation to prevent concurrent modifications
   */
  private queueOperation(operation: () => Promise<void>): void {
    this.operationQueue.push(operation);
    void this.processQueue();
  }

  /**
   * Process queued operations sequentially
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    while (this.operationQueue.length > 0) {
      const operation = this.operationQueue.shift();
      if (operation) {
        try {
          await operation();
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.error(`Operation failed: ${error.message}`);
        }
      }
    }

    this.isProcessing = false;
  }

  /**
   * Collect files using fast-glob
   */
  private async collectFilesWithGlob(): Promise<string[]> {
    return collectIndexableFiles(this.directory, this.ig);
  }

  /**
   * Perform full initial indexing
   */
  private async fullIndex(): Promise<void> {
    logger.info("Starting full index...");

    const files = await this.collectFilesWithGlob();
    let indexed = 0;
    let skipped = 0;

    for (const filePath of files) {
      try {
        const readResult = readSecureTextFile(filePath, this.directory);
        if (!readResult.ok || readResult.content === undefined) {
          const readError = readResult.ok
            ? "File cannot be read"
            : readResult.error;
          throw new Error(readError);
        }
        const content = readResult.content;

        const newHash = this.getChangedContentHash(filePath, content);
        if (newHash === undefined) {
          skipped++;
          continue;
        }

        const embeddedChunks = await embedFileContent(
          filePath,
          content,
          this.config,
          this.embeddingClient,
          this.enrichmentOptions,
        );
        if (embeddedChunks.length === 0) {
          await this.vectorStore.replaceFileChunks(filePath, []);
          this.hashCache.set(filePath, newHash);
          continue;
        }

        await this.vectorStore.replaceFileChunks(filePath, embeddedChunks);
        this.hashCache.set(filePath, newHash);
        indexed++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const relativePath = path.relative(this.directory, filePath);
        logger.debug(`Error indexing ${relativePath}: ${message}`);
      }
    }

    await this.hashCache.save();

    logger.info(
      `Full index: ${String(indexed)} indexed, ${String(skipped)} skipped`,
    );
  }

  /**
   * Start watching for file changes
   */
  async start(): Promise<void> {
    const health = await this.embeddingClient.healthCheck();
    if (!health.ok) {
      throw new Error(health.error ?? "Ollama is not available");
    }

    // Check if index exists BEFORE connect (connect creates the directory)
    const needsFullIndex = !this.vectorStore.exists();

    await this.vectorStore.connect();

    if (needsFullIndex) {
      await this.fullIndex();
    }

    this.watcher = watch(this.directory, {
      ignored: (filePath: string) => {
        const relativePath = path
          .relative(this.directory, filePath)
          .replace(/\\/g, "/");
        // Skip empty paths or root directory
        if (!relativePath) {
          return false;
        }
        const pathParts = relativePath.split("/");
        const parentParts = pathParts.slice(0, -1);
        // Skip hidden folders, but allow explicitly configured hidden files.
        if (parentParts.some((part) => part.startsWith("."))) {
          return true;
        }
        const filename = pathParts.at(-1) ?? "";
        if (filename.startsWith(".") && !shouldIndexFile(filename)) {
          return true;
        }
        return this.ig.ignores(relativePath);
      },
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this.watcher.on("add", (filePath: string) => {
      if (shouldIndexFile(filePath)) {
        this.scheduleChange("add", filePath);
      }
    });

    this.watcher.on("change", (filePath: string) => {
      if (shouldIndexFile(filePath)) {
        this.scheduleChange("change", filePath);
      }
    });

    this.watcher.on("unlink", (filePath: string) => {
      if (shouldIndexFile(filePath)) {
        this.scheduleChange("unlink", filePath);
      }
    });

    this.watcher.on("ready", () => {
      logger.info(
        `Watching: ${this.directory} (${String(this.debounceMs)}ms debounce)`,
      );
      this.onReady?.();
    });

    this.watcher.on("error", (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`Watcher error: ${error.message}`);
      this.onError?.(error);
    });
  }

  /**
   * Stop watching and cleanup
   */
  async stop(): Promise<void> {
    for (const pending of this.pendingChanges.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingChanges.clear();

    await this.hashCache.save();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.vectorStore.close();
    logger.info("Watcher stopped");
  }

  /**
   * Check if watcher is running
   */
  isRunning(): boolean {
    return this.watcher !== null;
  }

  /**
   * Clear the hash cache
   */
  clearCache(): void {
    this.hashCache.clear();
    logger.info("Hash cache cleared");
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { cachedFiles: number; cacheSize: number } {
    return this.hashCache.stats();
  }
}

/**
 * Create a new index watcher
 */
export function createIndexWatcher(options: WatcherOptions): IndexWatcher {
  return new IndexWatcher(options);
}
