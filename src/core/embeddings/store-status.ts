import type * as lancedb from "@lancedb/lancedb";

import type { IndexMetadata, IndexStatus } from "@core/embeddings/types";
import type { IndexMaintenanceStatus, LanceDBRow } from "./store-types";
import { nonNegativeInteger } from "./store-utils";

export async function readMaintenanceStatus(
  table: lancedb.Table | null,
  metadata: IndexMetadata | undefined,
  metadataError: string | undefined,
): Promise<IndexMaintenanceStatus> {
  const status: IndexMaintenanceStatus = {
    tablePresent: table !== null,
    versionCount: 0,
    totalBytes: 0,
    rows: 0,
    fragmentCount: 0,
    smallFragmentCount: 0,
    indices: [],
    metadataSchemaVersion: metadata?.schemaVersion,
    metadataCompatible: metadataError === undefined,
    ...(metadataError === undefined ? {} : { metadataError }),
  };
  if (!table) {
    return status;
  }

  try {
    status.tableVersion = await table.version();
  } catch {
    // A partially written table can still expose useful status below.
  }
  try {
    status.versionCount = (await table.listVersions()).length;
  } catch {
    status.versionCount = 0;
  }
  try {
    const stats = await table.stats();
    status.totalBytes = nonNegativeInteger(stats.totalBytes);
    status.rows = nonNegativeInteger(stats.numRows);
    status.fragmentCount = nonNegativeInteger(stats.fragmentStats.numFragments);
    status.smallFragmentCount = nonNegativeInteger(stats.fragmentStats.numSmallFragments);
  } catch {
    // Keep normalized zero values and let the caller inspect warnings.
  }
  try {
    status.indices = (await table.listIndices())
      .map((index) => index.name)
      .filter((name): name is string => typeof name === "string")
      .sort();
  } catch {
    status.indices = [];
  }
  try {
    const manifestTable = table as unknown as {
      usesV2ManifestPaths?: () => Promise<boolean>;
    };
    if (typeof manifestTable.usesV2ManifestPaths === "function") {
      status.manifestPathsV2 = await manifestTable.usesV2ManifestPaths.call(table);
    }
  } catch {
    // Older LanceDB tables may not expose this capability.
  }
  return status;
}

export async function readIndexStatus(
  table: lancedb.Table | null,
  directory: string,
  indexPath: string,
  exists: boolean,
  metadata: IndexMetadata | undefined,
  metadataError: string | undefined,
): Promise<IndexStatus> {
  const status: IndexStatus = {
    directory,
    indexPath,
    exists,
    totalChunks: 0,
    totalFiles: 0,
    languages: {},
    metadata,
    metadataError,
  };
  if (!table) {
    return status;
  }

  const rows = (await table.query().toArray()) as LanceDBRow[];
  const uniqueFiles = new Set<string>();
  for (const row of rows) {
    uniqueFiles.add(row.filePath);
    status.languages[row.language] = (status.languages[row.language] ?? 0) + 1;
  }
  status.totalChunks = rows.length;
  status.totalFiles = uniqueFiles.size;
  return status;
}

export async function readIndexedFiles(table: lancedb.Table | null): Promise<string[]> {
  if (!table) {
    return [];
  }
  const rows = (await table.query().select(["filePath"]).toArray()) as Pick<
    LanceDBRow,
    "filePath"
  >[];
  return Array.from(new Set(rows.map(({ filePath }) => filePath)));
}
