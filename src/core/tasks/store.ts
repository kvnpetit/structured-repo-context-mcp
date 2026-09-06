import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { writeJsonAtomically } from "@core/utils";

import type { StoredTask, TaskError, TaskStatus } from "@core/tasks/types";

const STORE_VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_RESULT_BYTES = 1024 * 1024;

interface PersistedState {
  version: number;
  tasks: Record<string, StoredTask>;
}

export interface TaskStoreOptions {
  filePath?: string;
  ttlMs?: number | null;
  pollIntervalMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    value === "working" ||
    value === "input_required" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function validStoredTask(value: unknown): value is StoredTask {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.taskId === "string" &&
    typeof value.toolName === "string" &&
    isTaskStatus(value.status) &&
    typeof value.createdAt === "string" &&
    typeof value.lastUpdatedAt === "string" &&
    (value.ttlMs === null ||
      (typeof value.ttlMs === "number" &&
        Number.isSafeInteger(value.ttlMs) &&
        value.ttlMs >= 0))
  );
}

function defaultStorePath(): string {
  const configured = process.env.MCP_TASK_STORE_DIR?.trim();
  const directory =
    configured === undefined || configured.length === 0
      ? path.join(os.tmpdir(), "src-mcp-tasks")
      : path.resolve(configured);
  return path.join(directory, "tasks.json");
}

function configuredTtl(): number | null {
  const raw = process.env.MCP_TASK_TTL_MS?.trim();
  if (raw === "none" || raw === "unlimited") {
    return null;
  }
  if (raw !== undefined && raw.length > 0) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_TTL_MS;
}

function configuredPollInterval(): number {
  const parsed = Number(process.env.MCP_TASK_POLL_INTERVAL_MS);
  return positiveInteger(parsed, DEFAULT_POLL_INTERVAL_MS);
}

function isExpired(task: StoredTask, now: number): boolean {
  if (task.ttlMs === null) {
    return false;
  }
  const created = Date.parse(task.createdAt);
  return Number.isFinite(created) && now >= created + task.ttlMs;
}

/**
 * A small single-process durable task store.
 *
 * State is replaced through the same atomic writer used by the index cache.
 * A worker crash therefore leaves either the previous complete snapshot or a
 * complete new snapshot; the manager marks unfinished work as failed on the
 * next process start instead of pretending it can resume arbitrary code.
 */
export class DurableTaskStore {
  readonly filePath: string;
  readonly ttlMs: number | null;
  readonly pollIntervalMs: number;
  private tasks = new Map<string, StoredTask>();

  constructor(options: TaskStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultStorePath();
    this.ttlMs = options.ttlMs !== undefined ? options.ttlMs : configuredTtl();
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs,
      configuredPollInterval(),
    );
    this.load();
    this.purgeExpired();
  }

  create(toolName: string): StoredTask {
    const now = new Date().toISOString();
    const task: StoredTask = {
      taskId: randomUUID(),
      toolName,
      status: "working",
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: this.ttlMs,
      pollIntervalMs: this.pollIntervalMs,
    };
    this.commit(new Map(this.tasks).set(task.taskId, task));
    return clone(task);
  }

  get(taskId: string): StoredTask | undefined {
    this.purgeExpired();
    const task = this.tasks.get(taskId);
    return task === undefined ? undefined : clone(task);
  }

  setStatusMessage(
    taskId: string,
    statusMessage: string,
  ): StoredTask | undefined {
    const task = this.tasks.get(taskId);
    if (task === undefined || isTerminal(task.status)) {
      return task === undefined ? undefined : clone(task);
    }
    const next = {
      ...task,
      statusMessage: statusMessage.slice(0, 500),
      lastUpdatedAt: new Date().toISOString(),
    };
    this.commit(new Map(this.tasks).set(taskId, next));
    return clone(next);
  }

  setInputRequired(
    taskId: string,
    inputRequests: Record<string, unknown>,
  ): StoredTask | undefined {
    return this.transition(taskId, "input_required", {
      inputRequests: clone(inputRequests),
    });
  }

  markWorking(taskId: string): StoredTask | undefined {
    return this.transition(taskId, "working", {
      inputRequests: undefined,
    });
  }

  complete(
    taskId: string,
    result: Record<string, unknown>,
  ): StoredTask | undefined {
    return this.transition(taskId, "completed", {
      result: clone(result),
      inputRequests: undefined,
      error: undefined,
    });
  }

  fail(taskId: string, error: TaskError): StoredTask | undefined {
    return this.transition(taskId, "failed", {
      error: clone(error),
      inputRequests: undefined,
    });
  }

  cancel(
    taskId: string,
    statusMessage = "Task cancelled",
  ): StoredTask | undefined {
    return this.transition(taskId, "cancelled", {
      statusMessage,
      inputRequests: undefined,
    });
  }

  markUnfinishedAsFailed(): number {
    const next = new Map(this.tasks);
    let changed = 0;
    for (const [taskId, task] of next) {
      if (isTerminal(task.status)) {
        continue;
      }
      next.set(taskId, {
        ...task,
        status: "failed",
        statusMessage: "Task interrupted by server restart",
        lastUpdatedAt: new Date().toISOString(),
        inputRequests: undefined,
        error: {
          code: -32603,
          message: "Task interrupted by server restart",
        },
      });
      changed += 1;
    }
    if (changed > 0) {
      this.commit(next);
    }
    return changed;
  }

  counts(): Record<TaskStatus, number> {
    this.purgeExpired();
    const counts: Record<TaskStatus, number> = {
      working: 0,
      input_required: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const task of this.tasks.values()) {
      counts[task.status] += 1;
    }
    return counts;
  }

  private transition(
    taskId: string,
    status: TaskStatus,
    fields: Partial<StoredTask>,
  ): StoredTask | undefined {
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      return undefined;
    }
    if (isTerminal(task.status)) {
      return clone(task);
    }
    if (!isAllowedTransition(task.status, status)) {
      return clone(task);
    }
    const next: StoredTask = {
      ...task,
      ...fields,
      status,
      lastUpdatedAt: new Date().toISOString(),
    };
    this.commit(new Map(this.tasks).set(taskId, next));
    return clone(next);
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(this.filePath, "utf8"),
      );
      if (
        !isRecord(parsed) ||
        parsed.version !== STORE_VERSION ||
        !isRecord(parsed.tasks)
      ) {
        return;
      }
      for (const [taskId, value] of Object.entries(parsed.tasks)) {
        if (
          taskId.length > 0 &&
          validStoredTask(value) &&
          value.taskId === taskId
        ) {
          this.tasks.set(taskId, clone(value));
        }
      }
    } catch {
      // A corrupt optional task cache must not prevent the code-intelligence
      // server from starting. New tasks will replace it with valid state.
      this.tasks.clear();
    }
  }

  private purgeExpired(): void {
    const now = Date.now();
    const next = new Map(this.tasks);
    let changed = false;
    for (const [taskId, task] of next) {
      if (isExpired(task, now)) {
        next.delete(taskId);
        changed = true;
      }
    }
    if (changed) {
      this.commit(next);
    }
  }

  private commit(next: Map<string, StoredTask>): void {
    const state: PersistedState = {
      version: STORE_VERSION,
      tasks: Object.fromEntries(next),
    };
    writeJsonAtomically(this.filePath, state);
    this.tasks = next;
  }
}

function isTerminal(status: TaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function isAllowedTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === "working") {
    return new Set<TaskStatus>([
      "working",
      "input_required",
      "completed",
      "failed",
      "cancelled",
    ]).has(to);
  }
  if (from === "input_required") {
    return new Set<TaskStatus>([
      "working",
      "completed",
      "failed",
      "cancelled",
    ]).has(to);
  }
  return false;
}

export { DEFAULT_MAX_RESULT_BYTES };
