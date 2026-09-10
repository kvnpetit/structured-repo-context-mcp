import type { SnapshotManifest, SnapshotSummary } from "./schema";

export interface SnapshotEntry {
  manifest?: SnapshotManifest;
  id: string;
}

export function summarizeSnapshots(
  snapshots: readonly SnapshotEntry[],
  limit: number,
): {
  summaries: SnapshotSummary[];
  totalBytes: number;
  truncated: boolean;
} {
  const valid = snapshots.filter(
    (entry): entry is { manifest: SnapshotManifest; id: string } => entry.manifest !== undefined,
  );
  return {
    summaries: valid.slice(0, limit).map((entry) => ({
      id: entry.id,
      created_at: entry.manifest.created_at,
      ...(entry.manifest.source_revision === undefined
        ? {}
        : { source_revision: entry.manifest.source_revision }),
      file_count: entry.manifest.files.length,
      total_bytes: entry.manifest.total_bytes,
      valid: true,
    })),
    totalBytes: valid.reduce((total, entry) => total + entry.manifest.total_bytes, 0),
    truncated: snapshots.length > limit,
  };
}
