import * as fs from "node:fs";
import * as path from "node:path";

import type { IndexMetadata } from "@core/embeddings/types";
import { writeJsonAtomically } from "@core/utils";

import type { VectorStoreConfig } from "./store-types";
import { INDEX_METADATA_FILE, INDEX_SCHEMA_VERSION } from "./store-utils";

const MAX_METADATA_BYTES = 64 * 1024;
const MAX_METADATA_STRING_LENGTH = 512;
const MAX_METADATA_DIMENSIONS = 1_000_000;
const MAX_METADATA_CHUNK_SIZE = 10_000_000;

export class IndexMetadataStore {
  private metadata: IndexMetadata | undefined;

  private metadataError: string | undefined;

  constructor(
    private readonly indexPath: string,
    private readonly config: VectorStoreConfig,
  ) {}

  get value(): IndexMetadata | undefined {
    return this.metadata;
  }

  get error(): string | undefined {
    return this.metadataError;
  }

  private get metadataPath(): string {
    return path.join(this.indexPath, INDEX_METADATA_FILE);
  }

  private expected(): Omit<IndexMetadata, "createdAt" | "updatedAt"> {
    return {
      schemaVersion: INDEX_SCHEMA_VERSION,
      embeddingProvider: this.config.embeddingProvider ?? "unknown",
      embeddingModel: this.config.embeddingModel ?? "unknown",
      embeddingDimensions: this.config.embeddingDimensions,
      chunkSize: this.config.defaultChunkSize,
      chunkOverlap: this.config.defaultChunkOverlap,
    };
  }

  private parse(value: unknown): IndexMetadata | undefined {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const parsed = value as Record<string, unknown>;
    const isBoundedString = (candidate: unknown): candidate is string =>
      typeof candidate === "string" && candidate.length <= MAX_METADATA_STRING_LENGTH;
    const isPositiveInteger = (candidate: unknown): candidate is number =>
      typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      candidate > 0 &&
      candidate <= MAX_METADATA_CHUNK_SIZE;
    const isNonNegativeInteger = (candidate: unknown): candidate is number =>
      typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0 &&
      candidate <= MAX_METADATA_CHUNK_SIZE;
    const isProvider = (candidate: unknown): candidate is IndexMetadata["embeddingProvider"] =>
      candidate === "ollama" || candidate === "lexical" || candidate === "unknown";
    const {
      schemaVersion,
      embeddingProvider,
      embeddingModel,
      embeddingDimensions,
      chunkSize,
      chunkOverlap,
      createdAt,
      updatedAt,
      sourceFingerprint,
      legacy,
    } = parsed;

    if (
      typeof schemaVersion !== "number" ||
      !Number.isSafeInteger(schemaVersion) ||
      schemaVersion < 0 ||
      schemaVersion > 100 ||
      !isProvider(embeddingProvider) ||
      !isBoundedString(embeddingModel) ||
      embeddingModel.length === 0 ||
      typeof embeddingDimensions !== "number" ||
      !Number.isSafeInteger(embeddingDimensions) ||
      embeddingDimensions <= 0 ||
      embeddingDimensions > MAX_METADATA_DIMENSIONS ||
      (chunkSize !== undefined && !isPositiveInteger(chunkSize)) ||
      (chunkOverlap !== undefined && !isNonNegativeInteger(chunkOverlap)) ||
      (chunkSize !== undefined && chunkOverlap !== undefined && chunkOverlap > chunkSize) ||
      !isBoundedString(createdAt) ||
      !isBoundedString(updatedAt) ||
      Number.isNaN(Date.parse(createdAt)) ||
      Number.isNaN(Date.parse(updatedAt)) ||
      (sourceFingerprint !== undefined &&
        (!isBoundedString(sourceFingerprint) || !/^[a-f0-9]{16,128}$/u.test(sourceFingerprint))) ||
      (legacy !== undefined && typeof legacy !== "boolean")
    ) {
      return undefined;
    }

    return {
      schemaVersion,
      embeddingProvider,
      embeddingModel,
      embeddingDimensions,
      ...(chunkSize === undefined ? {} : { chunkSize }),
      ...(chunkOverlap === undefined ? {} : { chunkOverlap }),
      createdAt,
      updatedAt,
      ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
      ...(typeof legacy === "boolean" ? { legacy } : {}),
    };
  }

  load(): void {
    this.metadata = undefined;
    this.metadataError = undefined;
    if (!fs.existsSync(this.metadataPath)) {
      return;
    }

    try {
      const fileStat = fs.lstatSync(this.metadataPath);
      if (!fileStat.isFile() || fileStat.size > MAX_METADATA_BYTES) {
        this.metadataError = "Index metadata is invalid; rebuild the index.";
        return;
      }
      const raw = fs.readFileSync(this.metadataPath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_METADATA_BYTES) {
        this.metadataError = "Index metadata is invalid; rebuild the index.";
        return;
      }
      const metadata = this.parse(JSON.parse(raw) as unknown);
      if (metadata === undefined) {
        this.metadataError = "Index metadata is invalid; rebuild the index.";
        return;
      }
      this.metadata = metadata;

      const expected = this.expected();
      if (
        metadata.schemaVersion !== expected.schemaVersion ||
        metadata.embeddingDimensions !== expected.embeddingDimensions ||
        metadata.embeddingProvider !== expected.embeddingProvider ||
        metadata.embeddingModel !== expected.embeddingModel ||
        metadata.chunkSize !== expected.chunkSize ||
        metadata.chunkOverlap !== expected.chunkOverlap
      ) {
        this.metadataError = "Index configuration mismatch; run index_codebase with force=true.";
      }
    } catch {
      this.metadataError = "Index metadata is unreadable; rebuild the index.";
    }
  }

  write(): void {
    const now = new Date().toISOString();
    const next: IndexMetadata = {
      ...this.expected(),
      createdAt: this.metadata?.createdAt ?? now,
      updatedAt: now,
      ...(this.metadata?.sourceFingerprint === undefined
        ? {}
        : { sourceFingerprint: this.metadata.sourceFingerprint }),
    };
    writeJsonAtomically(this.metadataPath, next);
    this.metadata = next;
    this.metadataError = undefined;
  }

  setSourceFingerprint(sourceFingerprint: string): void {
    if (this.metadata === undefined) {
      return;
    }
    const next: IndexMetadata = {
      ...this.metadata,
      sourceFingerprint,
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomically(this.metadataPath, next);
    this.metadata = next;
  }

  assertCompatible(): void {
    if (this.metadataError !== undefined) {
      throw new Error(this.metadataError);
    }
  }

  clear(): void {
    this.metadata = undefined;
    this.metadataError = undefined;
    fs.rmSync(this.metadataPath, { force: true });
  }
}
