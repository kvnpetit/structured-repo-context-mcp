/**
 * LanceDB vector store for code embeddings
 */

import * as lancedb from "@lancedb/lancedb";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  EmbeddedChunk,
  EmbeddingConfig,
  IndexStatus,
  SearchResult,
} from "@core/embeddings/types";

const TABLE_NAME = "code_chunks";
const INDEX_DIR_NAME = ".src-index";

/**
 * Type for LanceDB row results
 */
interface LanceDBRow {
  id: string;
  content: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  symbolName: string;
  symbolType: string;
  vector: number[];
  _distance?: number;
}

/**
 * LanceDB vector store wrapper
 */
export class VectorStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private readonly indexPath: string;

  constructor(
    directory: string,
    _config: Pick<EmbeddingConfig, "embeddingDimensions">,
  ) {
    this.indexPath = path.join(directory, INDEX_DIR_NAME);
  }

  /**
   * Initialize the database connection
   */
  async connect(): Promise<void> {
    this.db = await lancedb.connect(this.indexPath);

    const tableNames = await this.db.tableNames();
    if (tableNames.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    }
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db = null;
    this.table = null;
  }

  /**
   * Check if the index exists
   */
  exists(): boolean {
    return fs.existsSync(this.indexPath);
  }

  /**
   * Add embedded chunks to the store
   */
  async addChunks(chunks: EmbeddedChunk[]): Promise<void> {
    if (!this.db) {
      throw new Error("Database not connected. Call connect() first.");
    }

    const records = chunks.map((chunk) => ({
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

    if (!this.table) {
      this.table = await this.db.createTable(TABLE_NAME, records);
    } else {
      await this.table.add(records);
    }
  }

  /**
   * Search for similar chunks
   */
  async search(queryVector: number[], limit = 10): Promise<SearchResult[]> {
    if (!this.table) {
      return [];
    }

    const results = (await this.table
      .vectorSearch(queryVector)
      .limit(limit)
      .toArray()) as LanceDBRow[];

    return results.map((row) => ({
      chunk: {
        id: row.id,
        content: row.content,
        filePath: row.filePath,
        language: row.language,
        startLine: row.startLine,
        endLine: row.endLine,
        symbolName: row.symbolName || undefined,
        symbolType: row.symbolType || undefined,
      },
      score: row._distance ?? 0,
    }));
  }

  /**
   * Delete chunks by file path
   */
  async deleteByFilePath(filePath: string): Promise<void> {
    if (!this.table) {
      return;
    }

    await this.table.delete(`"filePath" = '${filePath.replace(/'/g, "''")}'`);
  }

  /**
   * Clear all data from the store
   */
  async clear(): Promise<void> {
    if (this.db && this.table) {
      await this.db.dropTable(TABLE_NAME);
      this.table = null;
    }
  }

  /**
   * Get index status
   */
  async getStatus(directory: string): Promise<IndexStatus> {
    const status: IndexStatus = {
      directory,
      indexPath: this.indexPath,
      exists: this.exists(),
      totalChunks: 0,
      totalFiles: 0,
      languages: {},
    };

    if (!this.table) {
      return status;
    }

    const allRows = (await this.table.query().toArray()) as LanceDBRow[];

    status.totalChunks = allRows.length;

    const uniqueFiles = new Set<string>();
    const languageCounts: Record<string, number> = {};

    for (const row of allRows) {
      uniqueFiles.add(row.filePath);
      const lang = row.language;
      languageCounts[lang] = (languageCounts[lang] ?? 0) + 1;
    }

    status.totalFiles = uniqueFiles.size;
    status.languages = languageCounts;

    return status;
  }

  /**
   * Get all indexed file paths
   */
  async getIndexedFiles(): Promise<string[]> {
    if (!this.table) {
      return [];
    }

    const rows = (await this.table
      .query()
      .select(["filePath"])
      .toArray()) as Pick<LanceDBRow, "filePath">[];
    const uniqueFiles = new Set<string>();

    for (const row of rows) {
      uniqueFiles.add(row.filePath);
    }

    return Array.from(uniqueFiles);
  }
}

/**
 * Create a vector store for a directory
 */
export function createVectorStore(
  directory: string,
  config: Pick<EmbeddingConfig, "embeddingDimensions">,
): VectorStore {
  return new VectorStore(directory, config);
}

/**
 * Get the index path for a directory
 */
export function getIndexPath(directory: string): string {
  return path.join(directory, INDEX_DIR_NAME);
}
