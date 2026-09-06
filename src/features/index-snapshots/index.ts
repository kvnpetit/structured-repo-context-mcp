import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { withProcessFileLock, writeJsonAtomically } from "@core/utils";
import { readLocalState } from "@core/local-state";
import { resolveSecureDirectory } from "@core/security";
import type { Feature, FeatureResult } from "@features/types";
import {
  indexSnapshotsOutputSchema,
  indexSnapshotsSchema,
  MAX_SNAPSHOT_FILES,
  SNAPSHOT_ID_PATTERN,
  snapshotManifestSchema,
  type IndexSnapshotsInput,
  type SnapshotFile,
  type SnapshotManifest,
} from "./schema";
import { summarizeSnapshots } from "./summaries";

const INDEX_DIRECTORY = ".src-index";
const SNAPSHOT_DIRECTORY = ".src-index-snapshots";
const WRITE_LOCK = ".src-index-write.lock";
export {
  indexSnapshotsOutputSchema,
  indexSnapshotsSchema,
  type IndexSnapshotsInput,
} from "./schema";

interface IndexFile {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
}

function isSafeRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/gu, "/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !/^[a-z]:\//iu.test(normalized) &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    !normalized.split("/").includes("..")
  );
}

function safeSnapshotPath(root: string, id: string): string {
  if (!SNAPSHOT_ID_PATTERN.test(id)) {
    throw new Error("Invalid snapshot identifier");
  }
  return path.join(root, SNAPSHOT_DIRECTORY, id);
}

function stateDirectory(root: string): string {
  return path.join(root, INDEX_DIRECTORY);
}

function snapshotsDirectory(root: string): string {
  return path.join(root, SNAPSHOT_DIRECTORY);
}

function ensureRegularDirectory(directory: string, create = false): void {
  if (!fs.existsSync(directory)) {
    if (create) {
      fs.mkdirSync(directory, { recursive: true });
      return;
    }
    throw new Error("Index directory does not exist");
  }
  const stats = fs.lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Index directory is not a regular directory");
  }
}

function collectIndexFiles(indexDirectory: string): IndexFile[] {
  const files: IndexFile[] = [];
  const stack = [indexDirectory];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        entry.name === ".write.lock" ||
        entry.name === WRITE_LOCK ||
        entry.name.endsWith(".tmp")
      ) {
        continue;
      }
      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("Index contains an unsupported symbolic link");
      }
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stats = fs.statSync(absolutePath);
      files.push({
        absolutePath,
        relativePath: path
          .relative(indexDirectory, absolutePath)
          .replace(/\\/gu, "/"),
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
      });
      if (files.length > MAX_SNAPSHOT_FILES) {
        throw new Error(
          `Snapshot exceeds the ${String(MAX_SNAPSHOT_FILES)}-file limit`,
        );
      }
    }
  }
  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

function hashFile(filePath: string): { sha256: string; sizeBytes: number } {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  let sizeBytes = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
      sizeBytes += bytesRead;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

function sourceRevision(root: string): string | undefined {
  const metadata = readLocalState(root, "metadata.json");
  if (
    !metadata.ok ||
    !metadata.exists ||
    typeof metadata.value !== "object" ||
    metadata.value === null
  ) {
    return undefined;
  }
  const value = metadata.value as { sourceFingerprint?: unknown };
  return typeof value.sourceFingerprint === "string"
    ? value.sourceFingerprint
    : undefined;
}

function snapshotId(): string {
  return `snapshot-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

function createSnapshot(root: string, maxBytes: number): SnapshotManifest {
  const indexDirectory = stateDirectory(root);
  ensureRegularDirectory(indexDirectory);
  const files = collectIndexFiles(indexDirectory);
  const estimatedBytes = files.reduce(
    (total, file) => total + file.sizeBytes,
    0,
  );
  if (estimatedBytes > maxBytes) {
    throw new Error(
      `Index snapshot exceeds the ${String(maxBytes)}-byte quota`,
    );
  }

  const id = snapshotId();
  const rootDirectory = snapshotsDirectory(root);
  ensureRegularDirectory(rootDirectory, true);
  const temporaryDirectory = path.join(rootDirectory, `.tmp-${id}`);
  const finalDirectory = safeSnapshotPath(root, id);
  fs.mkdirSync(path.join(temporaryDirectory, "payload"), { recursive: true });
  const snapshotFiles: SnapshotFile[] = [];
  try {
    let totalBytes = 0;
    for (const file of files) {
      const relative = file.relativePath;
      if (!isSafeRelativePath(relative)) {
        throw new Error("Index contains an unsafe relative path");
      }
      const destination = path.resolve(temporaryDirectory, "payload", relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(file.absolutePath, destination);
      const after = fs.statSync(file.absolutePath);
      if (after.size !== file.sizeBytes || after.mtimeMs !== file.mtimeMs) {
        throw new Error(`Index changed during snapshot: ${relative}`);
      }
      const digest = hashFile(destination);
      totalBytes += digest.sizeBytes;
      if (totalBytes > maxBytes) {
        throw new Error(
          `Index snapshot exceeds the ${String(maxBytes)}-byte quota`,
        );
      }
      snapshotFiles.push({
        path: relative,
        size_bytes: digest.sizeBytes,
        sha256: digest.sha256,
      });
    }
    const manifest: SnapshotManifest = {
      version: 1,
      id,
      created_at: new Date().toISOString(),
      ...(sourceRevision(root) === undefined
        ? {}
        : { source_revision: sourceRevision(root) }),
      total_bytes: totalBytes,
      files: snapshotFiles,
      complete: true,
    };
    writeJsonAtomically(
      path.join(temporaryDirectory, "manifest.json"),
      manifest,
    );
    fs.renameSync(temporaryDirectory, finalDirectory);
    return manifest;
  } finally {
    if (fs.existsSync(temporaryDirectory)) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

function readManifest(root: string, id: string): SnapshotManifest | undefined {
  try {
    const directory = safeSnapshotPath(root, id);
    ensureRegularDirectory(directory);
    const manifestPath = path.join(directory, "manifest.json");
    const stats = fs.lstatSync(manifestPath);
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      stats.size > 2 * 1024 * 1024
    ) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const result = snapshotManifestSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function listSnapshots(
  root: string,
): { manifest?: SnapshotManifest; id: string }[] {
  const directory = snapshotsDirectory(root);
  if (!fs.existsSync(directory)) {
    return [];
  }
  ensureRegularDirectory(directory);
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && SNAPSHOT_ID_PATTERN.test(entry.name),
    )
    .map((entry) => ({
      id: entry.name,
      manifest: readManifest(root, entry.name),
    }))
    .sort(
      (left, right) =>
        (right.manifest?.created_at ?? "").localeCompare(
          left.manifest?.created_at ?? "",
        ) || right.id.localeCompare(left.id),
    );
}

function verifySnapshot(
  root: string,
  manifest: SnapshotManifest,
  maxBytes: number,
): void {
  if (manifest.total_bytes > maxBytes) {
    throw new Error("Snapshot exceeds the configured restore quota");
  }
  const payload = path.join(safeSnapshotPath(root, manifest.id), "payload");
  ensureRegularDirectory(payload);
  let total = 0;
  for (const file of manifest.files) {
    if (!isSafeRelativePath(file.path)) {
      throw new Error("Snapshot contains an unsafe relative path");
    }
    const source = path.resolve(payload, file.path);
    if (
      !source.startsWith(`${path.resolve(payload)}${path.sep}`) &&
      source !== path.resolve(payload)
    ) {
      throw new Error("Snapshot path escapes its payload");
    }
    const stats = fs.lstatSync(source);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Snapshot file is missing: ${file.path}`);
    }
    const digest = hashFile(source);
    if (digest.sizeBytes !== file.size_bytes || digest.sha256 !== file.sha256) {
      throw new Error(`Snapshot verification failed: ${file.path}`);
    }
    total += digest.sizeBytes;
  }
  if (total !== manifest.total_bytes) {
    throw new Error("Snapshot manifest byte count is invalid");
  }
}

function restoreSnapshot(root: string, manifest: SnapshotManifest): void {
  const temporaryIndex = path.join(
    root,
    `.src-index-restore-${crypto.randomUUID()}`,
  );
  const currentIndex = stateDirectory(root);
  const backupIndex = path.join(
    root,
    `.src-index-recovery-${crypto.randomUUID()}`,
  );
  const payload = path.join(safeSnapshotPath(root, manifest.id), "payload");
  fs.mkdirSync(temporaryIndex, { recursive: true });
  try {
    for (const file of manifest.files) {
      const source = path.resolve(payload, file.path);
      const destination = path.resolve(temporaryIndex, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
    let movedCurrent = false;
    try {
      if (fs.existsSync(currentIndex)) {
        ensureRegularDirectory(currentIndex);
        fs.renameSync(currentIndex, backupIndex);
        movedCurrent = true;
      }
      fs.renameSync(temporaryIndex, currentIndex);
    } catch (error) {
      if (movedCurrent && !fs.existsSync(currentIndex)) {
        fs.renameSync(backupIndex, currentIndex);
      }
      throw error;
    }
    if (movedCurrent && fs.existsSync(backupIndex)) {
      fs.rmSync(backupIndex, { recursive: true, force: true });
    }
  } finally {
    if (fs.existsSync(temporaryIndex)) {
      fs.rmSync(temporaryIndex, { recursive: true, force: true });
    }
    if (fs.existsSync(backupIndex)) {
      fs.rmSync(backupIndex, { recursive: true, force: true });
    }
  }
}

function performCleanup(
  root: string,
  maxSnapshots: number,
  maxTotalBytes: number,
): string[] {
  const entries = listSnapshots(root);
  const deleted: string[] = [];
  let kept = 0;
  let total = 0;
  for (const entry of entries) {
    if (entry.manifest === undefined) {
      continue;
    }
    const exceedsCount = kept >= maxSnapshots;
    const exceedsBytes =
      total + entry.manifest.total_bytes > maxTotalBytes && kept > 0;
    if (exceedsCount || exceedsBytes) {
      fs.rmSync(safeSnapshotPath(root, entry.id), {
        recursive: true,
        force: true,
      });
      deleted.push(entry.id);
      continue;
    }
    kept += 1;
    total += entry.manifest.total_bytes;
  }
  return deleted;
}

export async function execute(
  rawInput: IndexSnapshotsInput,
): Promise<FeatureResult> {
  const input = indexSnapshotsSchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }
  const root = secureDirectory.path;
  return withProcessFileLock(path.join(root, WRITE_LOCK), () => {
    let snapshotIdValue: string | undefined;
    let backupSnapshotId: string | undefined;
    let restored = false;
    let deletedSnapshots: string[] = [];
    const errors: string[] = [];
    try {
      if (input.operation === "snapshot") {
        const manifest = createSnapshot(root, input.max_snapshot_bytes);
        snapshotIdValue = manifest.id;
      } else if (input.operation === "restore") {
        const manifest = readManifest(root, input.snapshot_id);
        if (manifest === undefined) {
          return { success: false, error: "Snapshot is missing or corrupt" };
        }
        verifySnapshot(root, manifest, input.max_snapshot_bytes);
        if (input.backup_current && fs.existsSync(stateDirectory(root))) {
          const backup = createSnapshot(root, input.max_snapshot_bytes);
          backupSnapshotId = backup.id;
        }
        restoreSnapshot(root, manifest);
        snapshotIdValue = manifest.id;
        restored = true;
      } else if (input.operation === "cleanup") {
        deletedSnapshots = performCleanup(
          root,
          input.max_snapshots,
          input.max_total_bytes,
        );
      }
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Index snapshot operation failed",
      };
    }

    const summaries = summarizeSnapshots(listSnapshots(root), input.list_limit);
    const output = {
      directory: root,
      index_directory: INDEX_DIRECTORY,
      snapshot_directory: SNAPSHOT_DIRECTORY,
      operation: input.operation,
      ...(snapshotIdValue === undefined
        ? {}
        : { snapshot_id: snapshotIdValue }),
      ...(backupSnapshotId === undefined
        ? {}
        : { backup_snapshot_id: backupSnapshotId }),
      restored,
      deleted_snapshots: deletedSnapshots,
      snapshots: summaries.summaries,
      total_snapshot_bytes: summaries.totalBytes,
      quota_bytes:
        input.operation === "cleanup"
          ? input.max_total_bytes
          : input.max_snapshot_bytes,
      truncated: summaries.truncated,
      source_is_untrusted: true as const,
      secrets_redacted: true as const,
      errors,
    };
    return {
      success: true,
      message: `Index ${input.operation}: ${String(summaries.summaries.length)} snapshot${summaries.summaries.length === 1 ? "" : "s"}${deletedSnapshots.length > 0 ? `, ${String(deletedSnapshots.length)} deleted` : ""}`,
      data: output,
    };
  });
}

export const indexSnapshotsFeature: Feature<typeof indexSnapshotsSchema> = {
  name: "manage_index_snapshots",
  title: "Manage local index snapshots",
  description:
    "Create, verify, restore, list, and clean bounded local snapshots of the semantic index. Snapshots never leave the project, restore uses verified files and a recovery snapshot by default, and no project code is executed.",
  schema: indexSnapshotsSchema,
  outputSchema: indexSnapshotsOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  execute,
};
