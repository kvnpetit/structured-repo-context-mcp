import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import type { StoredTask, TaskStatus } from "./types";
import { isProcessAlive } from "./ownership";
import { retryTaskIo } from "./io";

export const MAX_STORED_TASKS = 1_024;
const MAX_STORE_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validStoredTask(value: unknown): value is StoredTask {
  if (!isRecord(value)) {
    return false;
  }
  const owner = value.owner;
  const error = value.error;
  return (
    typeof value.taskId === "string" &&
    typeof value.toolName === "string" &&
    ["working", "input_required", "completed", "failed", "cancelled"].includes(
      value.status as TaskStatus,
    ) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.lastUpdatedAt === "string" &&
    Number.isFinite(Date.parse(value.lastUpdatedAt)) &&
    (value.pollIntervalMs === undefined ||
      (typeof value.pollIntervalMs === "number" &&
        Number.isSafeInteger(value.pollIntervalMs) &&
        value.pollIntervalMs > 0)) &&
    (value.statusMessage === undefined || typeof value.statusMessage === "string") &&
    (value.inputRequests === undefined || isRecord(value.inputRequests)) &&
    (value.result === undefined || isRecord(value.result)) &&
    (error === undefined ||
      (isRecord(error) &&
        typeof error.code === "number" &&
        Number.isSafeInteger(error.code) &&
        typeof error.message === "string")) &&
    (value.ttlMs === null ||
      (typeof value.ttlMs === "number" && Number.isSafeInteger(value.ttlMs) && value.ttlMs >= 0)) &&
    (owner === undefined ||
      (isRecord(owner) &&
        typeof owner.pid === "number" &&
        Number.isSafeInteger(owner.pid) &&
        owner.pid > 0 &&
        typeof owner.instanceId === "string"))
  );
}

export function readTaskState(filePath: string): Map<string, StoredTask> {
  removeAbandonedWrites(filePath);
  let parsed: unknown;
  try {
    if (fs.statSync(filePath).size > MAX_STORE_BYTES) {
      throw new Error("Task store exceeds the storage limit");
    }
    parsed = JSON.parse(retryTaskIo(() => fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.tasks)) {
    throw new Error("Task store has an unsupported or corrupt format");
  }
  const entries = Object.entries(parsed.tasks);
  if (entries.length > MAX_STORED_TASKS) {
    throw new Error("Task store exceeds the task limit");
  }
  const tasks = new Map<string, StoredTask>();
  for (const [taskId, task] of entries) {
    if (taskId.length === 0 || !validStoredTask(task) || task.taskId !== taskId) {
      throw new Error("Task store contains a corrupt task record");
    }
    tasks.set(taskId, task);
  }
  return tasks;
}

function removeAbandonedWrites(filePath: string): void {
  const directory = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const match = /^(\d+)\.[a-f0-9-]+\.tmp$/u.exec(name.slice(prefix.length));
    if (match !== null && !isProcessAlive(Number(match[1]))) {
      retryTaskIo(() => {
        fs.rmSync(path.join(directory, name), { force: true });
      });
    }
  }
}

/** Called only while holding the store lock. Never copy over a valid snapshot. */
export function writeTaskState(filePath: string, tasks: Map<string, StoredTask>): void {
  if (tasks.size > MAX_STORED_TASKS) {
    throw new Error("Task store exceeds the task limit");
  }
  const content = JSON.stringify({
    version: 1,
    tasks: Object.fromEntries(tasks),
  });
  if (Buffer.byteLength(content, "utf8") > MAX_STORE_BYTES) {
    throw new Error("Task store exceeds the storage limit");
  }
  const temporaryPath = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    const descriptor = fs.openSync(temporaryPath, "wx");
    try {
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    retryTaskIo(() => {
      fs.renameSync(temporaryPath, filePath);
    });
  } finally {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Retain the original error if cleanup is unavailable as well.
    }
  }
}
