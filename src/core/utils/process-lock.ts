import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STALE_MS = 120_000;
const POLL_MS = 25;
const MAX_PROCESS_LOCK_BYTES = 4 * 1024;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_STALE_MS = 24 * 60 * 60_000;

interface ProcessLockRecord {
  pid: number;
  token: string;
  created_at: string;
}

export interface ProcessLockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    return fallback;
  }
  return Math.min(value, maximum);
}

async function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isStale(lockPath: string, staleMs: number): boolean {
  try {
    const stats = fs.statSync(lockPath);
    const age = Date.now() - stats.mtimeMs;
    if (age < staleMs) {
      return false;
    }
    if (!stats.isFile() || stats.size > MAX_PROCESS_LOCK_BYTES) {
      return true;
    }
    const record = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<ProcessLockRecord>;
    if (typeof record.pid === "number" && isProcessAlive(record.pid)) {
      return age >= staleMs * 10;
    }
    return true;
  } catch {
    return true;
  }
}

function tryAcquire(lockPath: string, staleMs: number): string | undefined {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const record: ProcessLockRecord = {
    pid: process.pid,
    token,
    created_at: new Date().toISOString(),
  };
  for (;;) {
    try {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify(record), "utf8");
      } finally {
        fs.closeSync(descriptor);
      }
      return token;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== "EEXIST") {
        throw new Error("Unable to create local process lock");
      }
      if (isStale(lockPath, staleMs)) {
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch {
          // Another process may have replaced or removed the lock; retry.
        }
      }
      return undefined;
    }
  }
}

async function acquireAsync(
  lockPath: string,
  options: Required<ProcessLockOptions>,
): Promise<string> {
  const started = Date.now();
  for (;;) {
    const token = tryAcquire(lockPath, options.staleMs);
    if (token !== undefined) {
      return token;
    }
    if (Date.now() - started >= options.timeoutMs) {
      throw new Error("Timed out waiting for the local index lock");
    }
    await delay(Math.min(POLL_MS, options.timeoutMs));
  }
}

function release(lockPath: string, token: string): void {
  try {
    const stats = fs.statSync(lockPath);
    if (!stats.isFile() || stats.size > MAX_PROCESS_LOCK_BYTES) {
      return;
    }
    const record = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<ProcessLockRecord>;
    if (record.token !== token) {
      return;
    }
    fs.unlinkSync(lockPath);
  } catch {
    // A stale-lock recovery or process crash may already have removed it.
  }
}

/** Serialize mutations across processes with stale-lock recovery. */
export async function withProcessFileLock<T>(
  lockPath: string,
  operation: () => T | Promise<T>,
  options: ProcessLockOptions = {},
): Promise<T> {
  const normalizedOptions: Required<ProcessLockOptions> = {
    timeoutMs: boundedPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    staleMs: boundedPositiveInteger(options.staleMs, DEFAULT_STALE_MS, MAX_STALE_MS),
  };
  const token = await acquireAsync(lockPath, normalizedOptions);
  try {
    return await operation();
  } finally {
    release(lockPath, token);
  }
}
