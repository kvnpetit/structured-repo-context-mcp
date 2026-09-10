import path from "node:path";
import fg from "fast-glob";
import type { Ignore } from "ignore";

import {
  chunkFile,
  shouldIndexFile,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_FILENAMES,
} from "@core/embeddings/chunker";
import type { EmbeddingClient } from "@core/embeddings/client";
import { validateEmbeddingBatch } from "@core/embeddings/client";
import { enrichChunksFromFile, type EnrichmentOptions } from "@core/embeddings/enricher";
import type { EmbeddedChunk, EmbeddingConfig } from "@core/embeddings/types";
export { computeContentHash } from "@core/embeddings/hash-cache";
import { isSensitiveFileName } from "@core/files";
import { resolveSecurePath } from "@core/security";

export function shouldIndexPath(
  directory: string,
  ignoreFilter: Ignore,
  filePath: string,
): boolean {
  const securePath = resolveSecurePath(filePath, {
    kind: "file",
    root: directory,
    allowMissing: true,
  });
  if (!securePath.ok) {
    return false;
  }
  const relativePath = path.relative(directory, filePath).replace(/\\/g, "/");
  const parentParts = relativePath.split("/").slice(0, -1);
  if (parentParts.some((part) => part.startsWith(".")) || ignoreFilter.ignores(relativePath)) {
    return false;
  }
  return !isSensitiveFileName(path.basename(filePath)) && shouldIndexFile(filePath);
}

export async function collectIndexableFiles(
  directory: string,
  ignoreFilter: Ignore,
): Promise<string[]> {
  const extensions = SUPPORTED_EXTENSIONS.map((extension) => extension.slice(1));
  const patterns = [
    `**/*.{${extensions.join(",")}}`,
    ...SUPPORTED_FILENAMES.map((filename) => `**/${filename}`),
    "**/dockerfile.*",
    "**/.env.*",
  ];
  const files = await fg(patterns, {
    cwd: directory,
    absolute: true,
    ignore: ["**/.*/**"],
    dot: true,
    caseSensitiveMatch: false,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  return files.filter((filePath) => shouldIndexPath(directory, ignoreFilter, filePath));
}

export async function embedFileContent(
  filePath: string,
  content: string,
  config: EmbeddingConfig,
  embeddingClient: EmbeddingClient,
  enrichmentOptions: EnrichmentOptions,
): Promise<EmbeddedChunk[]> {
  const chunks = await chunkFile(filePath, content, config);
  if (chunks.length === 0) {
    return [];
  }
  const enrichedChunks = await enrichChunksFromFile(chunks, content, enrichmentOptions);
  const texts = enrichedChunks.map((chunk) => chunk.enrichedContent);
  const embeddings = await embeddingClient.embedBatch(texts);
  validateEmbeddingBatch(embeddings, texts.length, config.embeddingDimensions);
  return enrichedChunks.map((chunk, index) => ({
    id: chunk.id,
    content: chunk.content,
    filePath: chunk.filePath,
    language: chunk.language,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    symbolName: chunk.symbolName,
    symbolType: chunk.symbolType,
    vector: embeddings[index] ?? [],
  }));
}
