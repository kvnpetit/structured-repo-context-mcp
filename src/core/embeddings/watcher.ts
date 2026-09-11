/**
 * File watcher for automatic index updates
 *
 * Features:
 * - SHA-256 hash comparison to detect real content changes
 * - Debounce (5s default) to handle rapid changes
 * - Persistent hash cache to avoid unnecessary re-indexing
 * - fast-glob for efficient file scanning
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { shouldIndexFile } from "@core/embeddings/chunker";
import {
  createLexicalEmbeddingClient,
  type EmbeddingClient,
  OllamaClient,
} from "@core/embeddings/client";
import type { EnrichmentOptions } from "@core/embeddings/enricher";
import { VectorStore } from "@core/embeddings/store";
import type { EmbeddingConfig } from "@core/embeddings/types";
import { WatcherHashCache } from "@core/embeddings/watcher-cache";
import {
  collectIndexableFiles,
  embedFileContent,
  shouldIndexPath,
} from "@core/embeddings/watcher-indexing";
import { createIgnoreFilter } from "@core/files";
import { readSecureTextFile, resolveSecureDirectory } from "@core/security";
import { readPathAliasesCached } from "@core/utils";
import { logger } from "@utils";
import { type FSWatcher, watch } from "chokidar";
import type { Ignore } from "ignore";

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
  private readonly watchDirectory: string;
  private readonly config: EmbeddingConfig;
  private readonly debounceMs: number;
  private readonly embeddingClient: EmbeddingClient;
  private readonly vectorStore: VectorStore;
  private readonly enrichmentOptions: EnrichmentOptions;
  private watcher: FSWatcher | null = null;
  private ig: Ignore;
  private readonly hashCache: WatcherHashCache;
  private pendingChanges = new Map<string, PendingChange>();
  private operations: Promise<void> = Promise.resolve();
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private stopRequested = false;
  private releaseStartup: (() => void) | undefined;

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
    // chokidar ultimately delegates to Node's native fs.watch on Windows.
    // Resolve short-path aliases before opening that watcher, while keeping
    // the caller's resolved path for project-relative index and cache entries.
    try {
      this.watchDirectory =
        process.platform === "win32"
          ? fs.realpathSync.native(secureDirectory.path)
          : secureDirectory.path;
    } catch {
      // The secure resolver already confirmed that the directory exists. Keep
      // its resolved path if native canonicalization is unavailable.
      this.watchDirectory = secureDirectory.path;
    }
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
  private getChangedContentHash(filePath: string, content: string): string | undefined {
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

  /** Map paths reported by a canonical watcher back to the project path. */
  private normalizeWatchedPath(filePath: string): string {
    if (this.watchDirectory === this.directory) {
      return filePath;
    }
    const relativePath = path.relative(this.watchDirectory, filePath);
    const isDescendant =
      relativePath === "" ||
      (relativePath !== ".." &&
        !relativePath.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativePath));
    return isDescendant ? path.resolve(this.directory, relativePath) : filePath;
  }

  /**
   * Schedule a file change with debouncing
   */
  private scheduleChange(type: "add" | "change" | "unlink", filePath: string): void {
    if (this.stopRequested) {
      return;
    }
    const existing = this.pendingChanges.get(filePath);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.pendingChanges.delete(filePath);
      void this.queueOperation(async () => this.processChange(type, filePath)).catch(
        () => undefined,
      );
    }, this.debounceMs);

    this.pendingChanges.set(filePath, { type, filePath, timer });

    logger.debug(`Scheduled ${type}: ${path.basename(filePath)} (${String(this.debounceMs)}ms)`);
  }

  /**
   * Process a file change after debounce
   */
  private async processChange(type: "add" | "change" | "unlink", filePath: string): Promise<void> {
    if (type === "unlink") {
      await this.removeFile(filePath);
    } else {
      await this.indexFile(filePath);
    }
  }

  /**
   * Index a single file
   */
  private async indexFile(filePath: string, persist = true): Promise<void> {
    if (!this.shouldIndex(filePath)) {
      return;
    }

    try {
      const readResult = readSecureTextFile(filePath, this.directory);
      if (!readResult.ok || readResult.content === undefined) {
        const readError = readResult.ok ? "File cannot be read" : readResult.error;
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
      await this.vectorStore.replaceFileChunks(filePath, embeddedChunks);
      this.hashCache.set(filePath, newHash);
      if (persist) {
        await this.hashCache.save();
      }

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
  private async removeFile(filePath: string, persist = true): Promise<void> {
    try {
      await this.vectorStore.deleteByFilePath(filePath);
      this.removeFromHashCache(filePath);
      if (persist) {
        await this.hashCache.save();
      }

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
  private async queueOperation(operation: () => Promise<void>): Promise<void> {
    const next = this.operations.then(operation);
    this.operations = next.catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`Operation failed: ${error.message}`);
    });
    return next;
  }

  /** Move debounced changes into the serialized queue without waiting. */
  private flushPendingChanges(): void {
    for (const pending of this.pendingChanges.values()) {
      clearTimeout(pending.timer);
      void this.queueOperation(async () =>
        this.processChange(pending.type, pending.filePath),
      ).catch(() => undefined);
    }
    this.pendingChanges.clear();
  }

  /** Collect files using fast-glob. */
  private async collectFilesWithGlob(): Promise<string[]> {
    return collectIndexableFiles(this.directory, this.ig);
  }

  /**
   * Reconcile current files with persisted rows, including changes while offline.
   */
  private async fullIndex(): Promise<void> {
    logger.info("Reconciling index...");
    const files = (await this.collectFilesWithGlob()).map((file) => path.resolve(file));
    const currentFiles = new Set(files);
    const indexedFiles = new Set(
      (await this.vectorStore.getIndexedFiles()).map((file) => path.resolve(file)),
    );
    for (const filePath of indexedFiles) {
      if (!currentFiles.has(path.resolve(filePath))) {
        await this.removeFile(filePath, false);
      }
    }
    for (const filePath of this.hashCache.paths()) {
      if (!currentFiles.has(path.resolve(filePath))) {
        this.hashCache.remove(filePath);
      }
    }
    for (const filePath of files) {
      if (!indexedFiles.has(filePath)) {
        this.hashCache.remove(filePath);
      }
      await this.indexFile(filePath, false);
    }
    await this.hashCache.save();
    logger.info(`Index reconciled: ${String(files.length)} files checked`);
  }

  /**
   * Start watching for file changes
   */
  async start(): Promise<void> {
    if (this.stopping) {
      await this.stopping;
    }
    if (this.starting) {
      return this.starting;
    }
    this.stopRequested = false;
    this.starting = this.startWatching();
    try {
      await this.starting;
    } catch (error) {
      await this.watcher?.close();
      this.releaseStartup?.();
      await this.operations;
      this.watcher = null;
      this.vectorStore.close();
      this.starting = null;
      throw error;
    }
  }

  private async startWatching(): Promise<void> {
    const health = await this.embeddingClient.healthCheck();
    if (!health.ok) {
      throw new Error(health.error ?? "Ollama is not available");
    }

    await this.vectorStore.connect();
    this.vectorStore.assertMetadataCompatible();
    if (this.stopRequested) {
      return;
    }
    this.ig = this.createIgnoreFilter();
    this.hashCache.reload();
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      this.releaseStartup = resolve;
      rejectReady = reject;
    });
    // Reserve the first queue entry before events can arrive. Waiting for
    // chokidar's baseline closes the gap between scanning and watching.
    const reconciliation = this.queueOperation(async () => {
      await ready;
      await this.fullIndex();
    });

    this.watcher = watch(this.watchDirectory, {
      ignored: (filePath: string) => {
        const projectPath = this.normalizeWatchedPath(filePath);
        const relativePath = path.relative(this.directory, projectPath).replace(/\\/g, "/");
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
      const projectPath = this.normalizeWatchedPath(filePath);
      if (shouldIndexFile(projectPath)) {
        this.scheduleChange("add", projectPath);
      }
    });

    this.watcher.on("change", (filePath: string) => {
      const projectPath = this.normalizeWatchedPath(filePath);
      if (shouldIndexFile(projectPath)) {
        this.scheduleChange("change", projectPath);
      }
    });

    this.watcher.on("unlink", (filePath: string) => {
      const projectPath = this.normalizeWatchedPath(filePath);
      if (shouldIndexFile(projectPath)) {
        this.scheduleChange("unlink", projectPath);
      }
    });

    this.watcher.on("ready", () => this.releaseStartup?.());

    this.watcher.on("error", (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      rejectReady(error);
      logger.error(`Watcher error: ${error.message}`);
      this.onError?.(error);
    });
    await reconciliation;
    this.releaseStartup = undefined;
    this.flushPendingChanges();
    await this.operations;
    this.notifyReady();
  }

  private notifyReady(): void {
    if (!this.stopRequested) {
      logger.info(`Watching: ${this.directory} (${String(this.debounceMs)}ms debounce)`);
      this.onReady?.();
    }
  }

  /**
   * Stop watching and cleanup
   */
  async stop(): Promise<void> {
    if (this.stopping) {
      return this.stopping;
    }
    this.stopRequested = true;
    this.stopping = this.stopWatching();
    try {
      await this.stopping;
    } finally {
      this.stopping = null;
      this.starting = null;
    }
  }

  private async stopWatching(): Promise<void> {
    await this.watcher?.close();
    this.releaseStartup?.();
    await this.starting?.catch(() => undefined);
    this.flushPendingChanges();
    await this.operations;
    if (this.watcher) {
      // Closing chokidar can cancel its own awaitWriteFinish events. A final
      // scan accounts for those writes as well as our flushed debounce queue.
      await this.fullIndex();
    }
    await this.hashCache.save();
    this.vectorStore.close();
    this.watcher = null;
    logger.info("Watcher stopped");
  }

  /** Check if watcher is running. */
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

  /** Get cache statistics. */
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
