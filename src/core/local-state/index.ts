import * as fs from "node:fs";
import * as path from "node:path";

import { withProcessFileLock, writeJsonAtomically } from "@core/utils";

const LOCAL_STATE_DIRECTORY = ".src-index";
const MAX_LOCAL_STATE_BYTES = 4 * 1024 * 1024;

type LocalStateReadResult<T> =
  { ok: true; exists: boolean; value?: T } | { ok: false; error: string };

const stateLocks = new Map<string, Promise<void>>();

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function stateDirectory(root: string): string {
  return path.join(root, LOCAL_STATE_DIRECTORY);
}

function statePath(root: string, fileName: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,100}\.json$/iu.test(fileName)) {
    throw new Error("Invalid local state file name");
  }
  return path.join(stateDirectory(root), fileName);
}

function ensureStateDirectory(root: string): void {
  const directory = stateDirectory(root);
  if (fs.existsSync(directory)) {
    const stats = fs.lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Local state directory is not a regular directory");
    }
  } else {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function ensureRegularStateFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("Local state file is not a regular file");
  }
}

/** Read a versioned JSON file kept inside the caller's project `.src-index`. */
export function readLocalState<T = unknown>(
  root: string,
  fileName: string,
): LocalStateReadResult<T> {
  try {
    const filePath = statePath(root, fileName);
    const directory = stateDirectory(root);
    if (!fs.existsSync(directory)) {
      return { ok: true, exists: false };
    }
    const directoryStats = fs.lstatSync(directory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      return { ok: false, error: "Local state directory is not usable" };
    }
    if (!fs.existsSync(filePath)) {
      return { ok: true, exists: false };
    }
    ensureRegularStateFile(filePath);
    if (fs.statSync(filePath).size > MAX_LOCAL_STATE_BYTES) {
      return { ok: false, error: "Local state file exceeds the safety limit" };
    }
    return {
      ok: true,
      exists: true,
      value: JSON.parse(fs.readFileSync(filePath, "utf8")) as T,
    };
  } catch {
    return { ok: false, error: "Local state file is missing or corrupt" };
  }
}

/** Write a bounded JSON state file using the repository's atomic writer. */
export function writeLocalState(
  root: string,
  fileName: string,
  value: unknown,
): void {
  ensureStateDirectory(root);
  const filePath = statePath(root, fileName);
  ensureRegularStateFile(filePath);
  const serialized = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_LOCAL_STATE_BYTES) {
    throw new Error("Local state file exceeds the safety limit");
  }
  writeJsonAtomically(filePath, value);
}

/** Serialize state mutations per project across both promises and processes. */
export async function withLocalStateLock<T>(
  root: string,
  fileName: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const key = normalizedPath(statePath(root, fileName));
  const previous = stateLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous
    .catch(() => undefined)
    .then(async () => {
      await gate;
    });
  stateLocks.set(key, queued);
  await previous.catch(() => undefined);
  try {
    ensureStateDirectory(root);
    return await withProcessFileLock(
      `${statePath(root, fileName)}.lock`,
      operation,
    );
  } finally {
    release();
    if (stateLocks.get(key) === queued) {
      stateLocks.delete(key);
    }
  }
}

export function localStateRelativePath(fileName: string): string {
  statePath(".", fileName);
  return `${LOCAL_STATE_DIRECTORY}/${fileName}`;
}

export const LOCAL_STATE_VERSION = 1 as const;
