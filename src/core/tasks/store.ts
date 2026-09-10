import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { withTaskStoreLock } from "./locking";
import { isTaskOwnerAlive, type TaskOwner } from "./ownership";
import { MAX_STORED_TASKS, readTaskState, writeTaskState } from "./persistence";
import type { StoredTask, TaskError, TaskStatus } from "./types";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
export const DEFAULT_MAX_RESULT_BYTES = 1024 * 1024;

export interface TaskStoreOptions {
  filePath?: string;
  ttlMs?: number | null;
  pollIntervalMs?: number;
  owner?: TaskOwner;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultStorePath(): string {
  const configured = process.env.MCP_TASK_STORE_DIR?.trim();
  const directory = configured ? path.resolve(configured) : path.join(os.tmpdir(), "src-mcp-tasks");
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

function isTerminal(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isExpired(task: StoredTask, now: number): boolean {
  if (task.ttlMs === null) {
    return false;
  }
  const created = Date.parse(task.createdAt);
  return Number.isFinite(created) && now >= created + task.ttlMs;
}

function interrupted(task: StoredTask): StoredTask {
  return {
    ...task,
    status: "failed",
    statusMessage: "Task interrupted by server restart",
    lastUpdatedAt: new Date().toISOString(),
    inputRequests: undefined,
    error: { code: -32603, message: "Task interrupted by server restart" },
  };
}

/** Shared local state; every operation reloads its snapshot under a bounded lock. */
export class DurableTaskStore {
  readonly filePath: string;
  readonly ttlMs: number | null;
  readonly pollIntervalMs: number;
  private readonly owner: TaskOwner | undefined;
  private tasks = new Map<string, StoredTask>();

  constructor(options: TaskStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultStorePath();
    this.ttlMs = options.ttlMs !== undefined ? options.ttlMs : configuredTtl();
    this.owner = options.owner;
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs,
      positiveInteger(Number(process.env.MCP_TASK_POLL_INTERVAL_MS), DEFAULT_POLL_INTERVAL_MS),
    );
    this.transaction(() => undefined);
  }

  create(toolName: string): StoredTask {
    return this.transaction(() => {
      if (this.tasks.size >= MAX_STORED_TASKS) {
        throw new Error("Task store is full");
      }
      const now = new Date().toISOString();
      const task: StoredTask = {
        taskId: randomUUID(),
        toolName,
        status: "working",
        createdAt: now,
        lastUpdatedAt: now,
        ttlMs: this.ttlMs,
        pollIntervalMs: this.pollIntervalMs,
        ...(this.owner === undefined ? {} : { owner: this.owner }),
      };
      this.commit(new Map(this.tasks).set(task.taskId, task));
      return clone(task);
    });
  }

  get(taskId: string, recoverUnfinished = false): StoredTask | undefined {
    return this.transaction(() => {
      let task = this.tasks.get(taskId);
      if (
        task !== undefined &&
        recoverUnfinished &&
        !isTerminal(task.status) &&
        !isTaskOwnerAlive(task.owner)
      ) {
        task = interrupted(task);
        this.commit(new Map(this.tasks).set(taskId, task));
      }
      return task === undefined ? undefined : clone(task);
    });
  }

  /** Last known state is available for a controlled response during I/O failure. */
  cached(taskId: string): StoredTask | undefined {
    const task = this.tasks.get(taskId);
    return task === undefined ? undefined : clone(task);
  }

  setStatusMessage(taskId: string, statusMessage: string): StoredTask | undefined {
    return this.update(taskId, (task) => ({
      ...task,
      statusMessage: statusMessage.slice(0, 500),
    }));
  }
  setInputRequired(taskId: string, inputRequests: Record<string, unknown>): StoredTask | undefined {
    return this.transition(taskId, "input_required", {
      inputRequests: clone(inputRequests),
    });
  }
  markWorking(taskId: string): StoredTask | undefined {
    return this.transition(taskId, "working", { inputRequests: undefined });
  }
  complete(taskId: string, result: Record<string, unknown>): StoredTask | undefined {
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
  cancel(taskId: string, statusMessage = "Task cancelled"): StoredTask | undefined {
    return this.transition(taskId, "cancelled", {
      statusMessage,
      inputRequests: undefined,
    });
  }

  markUnfinishedAsFailed(): number {
    return this.transaction(() => {
      const next = new Map(this.tasks);
      let changed = 0;
      for (const [taskId, task] of next) {
        if (!isTerminal(task.status) && !isTaskOwnerAlive(task.owner)) {
          next.set(taskId, interrupted(task));
          changed += 1;
        }
      }
      if (changed > 0) {
        this.commit(next);
      }
      return changed;
    });
  }

  counts(refresh = true): Record<TaskStatus, number> {
    if (refresh) {
      return this.transaction(() => this.counts(false));
    }
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
    return this.update(taskId, (task) => ({ ...task, ...fields, status }));
  }

  private update(
    taskId: string,
    transform: (task: StoredTask) => StoredTask,
  ): StoredTask | undefined {
    return this.transaction(() => {
      const task = this.tasks.get(taskId);
      if (task === undefined || isTerminal(task.status)) {
        return task === undefined ? undefined : clone(task);
      }
      const next = {
        ...transform(task),
        lastUpdatedAt: new Date().toISOString(),
      };
      this.commit(new Map(this.tasks).set(taskId, next));
      return clone(next);
    });
  }

  private transaction<T>(run: () => T): T {
    return withTaskStoreLock(this.filePath, () => {
      this.tasks = readTaskState(this.filePath);
      const now = Date.now();
      const retained = new Map([...this.tasks].filter(([, task]) => !isExpired(task, now)));
      if (retained.size !== this.tasks.size) {
        this.commit(retained);
      }
      return run();
    });
  }

  private commit(next: Map<string, StoredTask>): void {
    writeTaskState(this.filePath, next);
    this.tasks = next;
  }
}
