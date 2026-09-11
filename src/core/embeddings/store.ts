/** LanceDB-backed vector, lexical, and hybrid code search store. */

import * as lancedb from "@lancedb/lancedb";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  EmbeddedChunk,
  IndexMetadata,
  IndexStatus,
  SearchResult,
} from "@core/embeddings/types";
import { logger } from "@utils";
import { assertSecureStateDirectory } from "@core/security";
import { IndexMetadataStore } from "./store-metadata";
import {
  getAdjacentChunks as findAdjacentChunks,
  searchFts as findFts,
  searchHybrid as findHybrid,
  searchLexical as findLexical,
  searchVector,
} from "./store-search";
import { readIndexedFiles, readIndexStatus, readMaintenanceStatus } from "./store-status";
import type {
  AdjacentChunks,
  HybridSearchOptions,
  IndexMaintenanceStatus,
  IndexOptimizationStats,
  LanceDBRow,
  VectorStoreConfig,
} from "./store-types";
import {
  chunkIdPredicate,
  hasIndexData,
  INDEX_DIR_NAME,
  nonNegativeInteger,
  normalizeFilePath,
  TABLE_NAME,
  toLanceRecords,
  validateAbsoluteFilePath,
  withIndexWriteLock,
} from "./store-utils";

export { computeSourceFingerprint, hasIndexData } from "./store-utils";
export type {
  AdjacentChunkResult,
  AdjacentChunks,
  HybridSearchOptions,
  IndexMaintenanceStatus,
  IndexOptimizationStats,
  SearchMode,
} from "./store-types";

export class VectorStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private readonly indexPath: string;
  private readonly directory: string;
  private readonly metadataStore: IndexMetadataStore;
  private ftsIndexCreated = false;

  private async getChunkIdsForFiles(filePaths: Iterable<string>): Promise<string[]> {
    if (!this.table) {
      return [];
    }

    const normalizedPaths = new Set(
      Array.from(filePaths, (filePath) => normalizeFilePath(filePath)),
    );
    const rows = (await this.table.query().select(["id", "filePath"]).toArray()) as Pick<
      LanceDBRow,
      "id" | "filePath"
    >[];
    return rows
      .filter((row) => normalizedPaths.has(normalizeFilePath(row.filePath)))
      .map((row) => row.id);
  }

  private async refreshTable(): Promise<void> {
    if (!this.db) {
      return;
    }

    const tableNames = await this.db.tableNames();
    this.table = tableNames.includes(TABLE_NAME) ? await this.db.openTable(TABLE_NAME) : null;
  }

  private async addChunksUnlocked(chunks: EmbeddedChunk[]): Promise<void> {
    if (!this.db) {
      throw new Error("Database not connected. Call connect() first.");
    }

    this.assertMetadataCompatible();
    const records = toLanceRecords(chunks);
    if (records.length === 0) {
      return;
    }

    if (!this.table) {
      this.table = await this.db.createTable(TABLE_NAME, records);
    } else {
      await this.table.add(records);
    }
    this.metadataStore.write();
  }

  constructor(directory: string, config: VectorStoreConfig) {
    this.directory = path.resolve(directory);
    this.indexPath = path.join(this.directory, INDEX_DIR_NAME);
    this.metadataStore = new IndexMetadataStore(this.indexPath, config);
  }

  /**
   * Initialize the database connection
   */
  async connect(): Promise<void> {
    assertSecureStateDirectory(this.directory, this.indexPath);
    fs.mkdirSync(this.indexPath, { recursive: true });
    assertSecureStateDirectory(this.directory, this.indexPath);
    this.db = await lancedb.connect(this.indexPath);

    try {
      assertSecureStateDirectory(this.directory, this.indexPath);
    } catch (error) {
      this.db.close();
      this.db = null;
      throw error;
    }

    const tableNames = await this.db.tableNames();
    if (tableNames.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    }
    this.metadataStore.load();
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.table?.close();
    this.db?.close();
    this.db = null;
    this.table = null;
  }

  getMetadata(): IndexMetadata | undefined {
    return this.metadataStore.value;
  }

  getMetadataError(): string | undefined {
    return this.metadataStore.error;
  }

  /** Persist the source revision represented by the current index. */
  setSourceFingerprint(sourceFingerprint: string): void {
    this.metadataStore.setSourceFingerprint(sourceFingerprint);
  }

  assertMetadataCompatible(): void {
    this.metadataStore.assertCompatible();
  }

  /**
   * Check if the index exists
   */
  exists(): boolean {
    return hasIndexData(path.dirname(this.indexPath));
  }

  /**
   * Add embedded chunks to the store
   */
  async addChunks(chunks: EmbeddedChunk[]): Promise<void> {
    if (!this.db) {
      throw new Error("Database not connected. Call connect() first.");
    }

    await withIndexWriteLock(this.indexPath, async () => {
      await this.refreshTable();
      await this.addChunksUnlocked(chunks);
    });
  }

  /**
   * Create FTS (Full-Text Search) index on content column
   * This enables BM25-based text search
   */
  async createFtsIndex(): Promise<void> {
    if (!this.table || this.ftsIndexCreated) {
      return;
    }

    try {
      await this.table.createIndex("content", {
        config: lancedb.Index.fts(),
        replace: false,
      });
      this.ftsIndexCreated = true;
      logger.debug("FTS index created on content column");
    } catch (error) {
      // Index may already exist
      if (error instanceof Error && error.message.includes("already exists")) {
        this.ftsIndexCreated = true;
        logger.debug("FTS index already exists");
      } else {
        logger.warn(
          `Failed to create FTS index: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Search for similar chunks using vector similarity
   */
  async search(queryVector: number[], limit = 10): Promise<SearchResult[]> {
    return searchVector(this.table, queryVector, limit);
  }

  async searchLexical(queryText: string, limit = 10): Promise<SearchResult[]> {
    return findLexical(this.table, queryText, limit);
  }

  async searchFts(queryText: string, limit = 10): Promise<SearchResult[]> {
    return findFts(this.table, async () => this.createFtsIndex(), queryText, limit);
  }

  async searchHybrid(
    queryVector: number[],
    queryText: string,
    limit = 10,
    options: HybridSearchOptions = {},
  ): Promise<SearchResult[]> {
    return findHybrid(
      this.table,
      async () => this.createFtsIndex(),
      queryVector,
      queryText,
      limit,
      options,
    );
  }

  async getAdjacentChunks(filePath: string, chunkId: string, window = 1): Promise<AdjacentChunks> {
    validateAbsoluteFilePath(filePath, "getAdjacentChunks");
    return findAdjacentChunks(this.table, filePath, chunkId, window);
  }

  async getMaintenanceStatus(): Promise<IndexMaintenanceStatus> {
    return readMaintenanceStatus(this.table, this.metadataStore.value, this.metadataStore.error);
  }

  /** Compact fragments and prune old local Lance table versions. */
  async optimizeIndex(
    cleanupOlderThanDays = 7,
    deleteUnverified = false,
  ): Promise<IndexOptimizationStats> {
    if (!this.db) {
      throw new Error("Database not connected. Call connect() first.");
    }
    this.assertMetadataCompatible();
    const days = Math.min(3_650, Math.max(0, cleanupOlderThanDays));
    return withIndexWriteLock(this.indexPath, async () => {
      await this.refreshTable();
      if (!this.table) {
        throw new Error("Index table does not exist");
      }
      const result = await this.table.optimize({
        cleanupOlderThan: new Date(Date.now() - days * 86_400_000),
        deleteUnverified,
      });
      return {
        compaction: {
          fragmentsRemoved: nonNegativeInteger(result.compaction.fragmentsRemoved),
          fragmentsAdded: nonNegativeInteger(result.compaction.fragmentsAdded),
          filesRemoved: nonNegativeInteger(result.compaction.filesRemoved),
          filesAdded: nonNegativeInteger(result.compaction.filesAdded),
        },
        prune: {
          bytesRemoved: nonNegativeInteger(result.prune.bytesRemoved),
          oldVersionsRemoved: nonNegativeInteger(result.prune.oldVersionsRemoved),
        },
      };
    });
  }

  /** Migrate the local Lance manifest paths when the installed SDK supports it. */
  async migrateIndexStorage(): Promise<boolean> {
    if (!this.db) {
      throw new Error("Database not connected. Call connect() first.");
    }
    return withIndexWriteLock(this.indexPath, async () => {
      await this.refreshTable();
      if (!this.table) {
        return false;
      }
      const manifestTable = this.table as unknown as {
        usesV2ManifestPaths?: () => Promise<boolean>;
        migrateManifestPathsV2?: () => Promise<void>;
      };
      if (
        typeof manifestTable.usesV2ManifestPaths !== "function" ||
        typeof manifestTable.migrateManifestPathsV2 !== "function"
      ) {
        throw new Error("The installed LanceDB runtime cannot migrate manifest paths");
      }
      const alreadyMigrated = await manifestTable.usesV2ManifestPaths.call(this.table);
      if (alreadyMigrated) {
        return false;
      }
      await manifestTable.migrateManifestPathsV2.call(this.table);
      return true;
    });
  }

  /**
   * Delete chunks by file path.
   *
   * NOTE: LanceDB does not support parameterized queries, so we use manual
   * single-quote escaping. The filePath is validated to be absolute to prevent
   * injection via relative or crafted paths.
   */
  async deleteByFilePath(filePath: string): Promise<void> {
    validateAbsoluteFilePath(filePath, "deleteByFilePath");

    if (!this.table) {
      return;
    }

    await withIndexWriteLock(this.indexPath, async () => {
      await this.refreshTable();
      const chunkIds = await this.getChunkIdsForFiles([filePath]);
      if (chunkIds.length > 0) {
        await this.table?.delete(chunkIdPredicate(chunkIds));
      }
    });
  }

  /**
   * Atomically replace every indexed chunk for one file.
   *
   * LanceDB merge-insert commits the updates, inserts, and removal of stale
   * rows as one table version. Empty replacements are a single delete.
   */
  async replaceFileChunks(filePath: string, chunks: EmbeddedChunk[]): Promise<void> {
    validateAbsoluteFilePath(filePath, "replaceFileChunks");
    await this.replaceFilesChunks(new Map([[filePath, chunks]]));
  }

  /** Atomically replace chunks for one or more files in a single table version. */
  async replaceFilesChunks(replacements: ReadonlyMap<string, EmbeddedChunk[]>): Promise<void> {
    if (replacements.size === 0) {
      return;
    }

    for (const [filePath, chunks] of replacements) {
      validateAbsoluteFilePath(filePath, "replaceFilesChunks");

      const mismatchedChunk = chunks.find(
        (chunk) => normalizeFilePath(chunk.filePath) !== normalizeFilePath(filePath),
      );
      if (mismatchedChunk) {
        throw new Error(
          `replaceFilesChunks received a chunk for another file: ${mismatchedChunk.filePath}`,
        );
      }
    }

    if (!this.db) {
      throw new Error("Database not connected. Call connect() first.");
    }

    this.assertMetadataCompatible();

    await withIndexWriteLock(this.indexPath, async () => {
      await this.refreshTable();
      const replacementChunks = Array.from(replacements.values()).flat();

      if (!this.table) {
        const tableNames = await this.db?.tableNames();
        if (tableNames?.includes(TABLE_NAME)) {
          this.table = (await this.db?.openTable(TABLE_NAME)) ?? null;
        }
      }

      if (!this.table) {
        if (replacementChunks.length > 0) {
          await this.addChunksUnlocked(replacementChunks);
        }
        return;
      }

      const replacementRows = toLanceRecords(replacementChunks);
      const uniqueIds = new Set(replacementRows.map((row) => row.id));
      if (uniqueIds.size !== replacementRows.length) {
        throw new Error("replaceFilesChunks requires unique replacement chunk IDs");
      }

      const oldChunkIds = await this.getChunkIdsForFiles(replacements.keys());
      if (replacementRows.length === 0) {
        if (oldChunkIds.length > 0) {
          await this.table.delete(chunkIdPredicate(oldChunkIds));
        }
        return;
      }

      let merge = this.table.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll();
      if (oldChunkIds.length > 0) {
        merge = merge.whenNotMatchedBySourceDelete({
          where: chunkIdPredicate(oldChunkIds),
        });
      }
      await merge.execute(replacementRows);
      this.metadataStore.write();
    });
  }

  /**
   * Clear all data from the store
   */
  async clear(): Promise<void> {
    await withIndexWriteLock(this.indexPath, async () => {
      if (this.db) {
        await this.refreshTable();
        if (this.table) {
          await this.db.dropTable(TABLE_NAME);
          this.table = null;
        }
      }
      this.metadataStore.clear();
      this.ftsIndexCreated = false;
    });
  }

  /**
   * Get index status
   */
  async getStatus(directory: string): Promise<IndexStatus> {
    return readIndexStatus(
      this.table,
      directory,
      this.indexPath,
      this.exists(),
      this.metadataStore.value,
      this.metadataStore.error,
    );
  }

  /** Revision of the table snapshot used by this store's queries. */
  async getRevision(): Promise<number | undefined> {
    return this.table?.version();
  }

  /** Get all indexed file paths. */
  async getIndexedFiles(): Promise<string[]> {
    return readIndexedFiles(this.table);
  }
}

/**
 * Create a vector store for a directory
 */
export function createVectorStore(directory: string, config: VectorStoreConfig): VectorStore {
  return new VectorStore(directory, config);
}

/**
 * Get the index path for a directory
 */
export function getIndexPath(directory: string): string {
  return path.join(directory, INDEX_DIR_NAME);
}
