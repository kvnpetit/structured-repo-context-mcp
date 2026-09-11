import { boundResult, toCreateTaskResult, toDetailedTask, toPublicTask } from "./results";
import * as os from "node:os";
import * as path from "node:path";

import type { FeatureExecutionContext } from "@features/types";
import { createTaskOwner, releaseTaskOwner, type TaskOwner } from "./ownership";

import {
  DurableTaskStore,
  DEFAULT_MAX_RESULT_BYTES,
  type TaskStoreOptions,
} from "@core/tasks/store";
import type {
  CreateTaskResult,
  DetailedTask,
  TaskError,
  TaskRuntimeConfig,
} from "@core/tasks/types";

const DEFAULT_MAX_ACTIVE_TASKS = 8;
const DEFAULT_TOOL_NAMES = ["index_codebase", "update_index"];

export interface TaskManagerOptions extends TaskStoreOptions {
  enabled?: boolean;
  reason?: string;
  recoverUnfinished?: boolean;
  maxResultBytes?: number;
  maxActiveTasks?: number;
  toolNames?: string[];
}

export interface TaskManagerStatus {
  enabled: boolean;
  reason?: string;
  activeTasks: number;
  maxActiveTasks: number;
  configuredTools: string[];
  counts: ReturnType<DurableTaskStore["counts"]>;
}

export interface TaskRunnerContext {
  signal: AbortSignal;
  reportProgress: FeatureExecutionContext["reportProgress"];
}

export type TaskRunner = (context: TaskRunnerContext) => Promise<Record<string, unknown>>;

function isDisabled(value: string | undefined): boolean {
  return value !== undefined && /^(?:0|false|off|disabled|no)$/iu.test(value.trim());
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTtl(): number | null {
  const raw = process.env.MCP_TASK_TTL_MS?.trim();
  if (raw === "none" || raw === "unlimited") {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 24 * 60 * 60 * 1000;
}

function parseToolNames(): string[] {
  const raw = process.env.MCP_TASK_TOOLS;
  if (raw === undefined) {
    return [...DEFAULT_TOOL_NAMES];
  }
  return raw
    .split(/[;,]/u)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

export function getTaskRuntimeConfig(): TaskRuntimeConfig {
  const configuredStoreDirectory = process.env.MCP_TASK_STORE_DIR?.trim();
  const storeDirectory =
    configuredStoreDirectory === undefined || configuredStoreDirectory.length === 0
      ? path.join(os.tmpdir(), "src-mcp-tasks")
      : path.resolve(configuredStoreDirectory);
  const maxResultBytes = parsePositiveInteger(
    process.env.MCP_TASK_MAX_RESULT_BYTES,
    DEFAULT_MAX_RESULT_BYTES,
  );
  return {
    enabled: !isDisabled(process.env.MCP_TASKS),
    storeFilePath: path.join(storeDirectory, "tasks.json"),
    ttlMs: parseTtl(),
    pollIntervalMs: parsePositiveInteger(process.env.MCP_TASK_POLL_INTERVAL_MS, 1000),
    maxResultBytes,
    maxActiveTasks: parsePositiveInteger(process.env.MCP_TASK_MAX_ACTIVE, DEFAULT_MAX_ACTIVE_TASKS),
    toolNames: parseToolNames(),
  };
}

export class TaskManager {
  readonly enabled: boolean;
  readonly reason: string | undefined;
  readonly maxResultBytes: number;
  readonly maxActiveTasks: number;
  readonly toolNames: ReadonlySet<string>;
  private readonly store: DurableTaskStore | undefined;
  private readonly active = new Map<string, AbortController>();
  private readonly owner: TaskOwner | undefined;
  private readonly recoverUnfinished: boolean;
  private readonly failedInMemory = new Map<string, DetailedTask>();
  private readonly pendingFailures = new Set<string>();
  private cancellationTimer: ReturnType<typeof setInterval> | undefined;
  private storageUnavailable = false;
  private closed = false;

  constructor(options: TaskManagerOptions = {}) {
    const runtime = getTaskRuntimeConfig();
    this.enabled = options.enabled ?? runtime.enabled;
    this.reason = options.reason;
    this.maxResultBytes = options.maxResultBytes ?? runtime.maxResultBytes;
    this.maxActiveTasks = options.maxActiveTasks ?? runtime.maxActiveTasks;
    this.toolNames = new Set(options.toolNames ?? runtime.toolNames);
    this.recoverUnfinished = options.recoverUnfinished !== false;
    if (this.enabled) {
      this.owner = createTaskOwner();
      try {
        this.store = new DurableTaskStore({
          filePath: options.filePath ?? runtime.storeFilePath,
          ttlMs: options.ttlMs !== undefined ? options.ttlMs : runtime.ttlMs,
          pollIntervalMs: options.pollIntervalMs ?? runtime.pollIntervalMs,
          owner: this.owner,
        });
        if (options.recoverUnfinished !== false) {
          this.store.markUnfinishedAsFailed();
        }
      } catch (error) {
        releaseTaskOwner(this.owner);
        throw error;
      }
    }
  }

  canCreateTask(toolName: string): boolean {
    return (
      this.enabled &&
      !this.closed &&
      !this.storageUnavailable &&
      this.store !== undefined &&
      this.toolNames.has(toolName) &&
      this.active.size < this.maxActiveTasks
    );
  }

  createTask(toolName: string, runner: TaskRunner): CreateTaskResult {
    if (!this.canCreateTask(toolName) || this.store === undefined) {
      throw new Error("Task execution is not available");
    }

    const stored = this.store.create(toolName);
    const controller = new AbortController();
    this.active.set(stored.taskId, controller);
    this.cancellationTimer ??= setInterval(() => {
      this.pollCancellation();
    }, 500).unref();
    void this.run(stored.taskId, controller, runner).catch(() => {
      this.degradeStorage();
    });
    return toCreateTaskResult(stored);
  }

  getTask(taskId: string): DetailedTask | undefined {
    this.flushFailures();
    const failed = this.failedInMemory.get(taskId);
    if (failed !== undefined) {
      return failed;
    }
    try {
      const task = this.store?.get(taskId, this.recoverUnfinished);
      return task === undefined ? undefined : toDetailedTask(task);
    } catch (error) {
      this.degradeStorage();
      const localFailure = this.failedInMemory.get(taskId);
      if (localFailure !== undefined) {
        return localFailure;
      }
      throw error;
    }
  }

  updateTask(taskId: string, inputResponses: Record<string, unknown>): boolean {
    const task = this.store?.get(taskId);
    if (task === undefined) {
      return false;
    }
    // Current SRC tools do not emit input_required. Keep the operation
    // idempotent and well-formed so a future input-producing runner can use
    // the same durable state machine without accepting arbitrary task fields.
    if (task.status === "input_required") {
      const outstanding = new Set(Object.keys(task.inputRequests ?? {}));
      const hasKnownResponse = Object.keys(inputResponses).some((key) => outstanding.has(key));
      if (hasKnownResponse && this.store !== undefined) {
        this.store.markWorking(taskId);
      }
    }
    return true;
  }

  cancelTask(taskId: string): boolean {
    const task = this.store?.get(taskId);
    if (task === undefined) {
      return false;
    }
    try {
      this.store?.cancel(taskId);
    } finally {
      this.active.get(taskId)?.abort();
    }
    return true;
  }

  /** Stop active runners when an owning server/HTTP listener is shutting down. */
  close(): void {
    this.closed = true;
    clearInterval(this.cancellationTimer);
    this.cancellationTimer = undefined;
    for (const [taskId, controller] of this.active) {
      try {
        this.store?.cancel(taskId, "Task cancelled because the server stopped");
      } catch {
        this.degradeStorage();
      }
      controller.abort();
    }
    if (this.owner !== undefined) {
      releaseTaskOwner(this.owner);
    }
  }

  getStatus(): TaskManagerStatus {
    this.flushFailures();
    let counts: ReturnType<DurableTaskStore["counts"]> | undefined;
    try {
      counts = this.store?.counts();
    } catch {
      this.degradeStorage();
    }
    const reason = this.storageUnavailable ? "Task store is unavailable" : this.reason;
    return {
      enabled: this.enabled,
      ...(reason === undefined ? {} : { reason }),
      activeTasks: this.active.size,
      maxActiveTasks: this.maxActiveTasks,
      configuredTools: [...this.toolNames],
      counts: counts ??
        this.store?.counts(false) ?? {
          working: 0,
          input_required: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
        },
    };
  }

  private degradeStorage(): void {
    this.storageUnavailable = true;
    if (this.owner !== undefined) {
      releaseTaskOwner(this.owner);
    }
    for (const [taskId, controller] of this.active) {
      const task = this.store?.cached(taskId);
      if (task !== undefined) {
        this.failedInMemory.set(taskId, {
          ...toPublicTask(task),
          status: "failed",
          error: { code: -32603, message: "Task store is unavailable" },
          statusMessage: "Task store is unavailable",
        });
        this.pendingFailures.add(taskId);
      }
      controller.abort();
    }
  }

  private pollCancellation(): void {
    if (this.storageUnavailable) {
      this.flushFailures();
      return;
    }
    try {
      for (const [taskId, controller] of this.active) {
        const task = this.store?.get(taskId);
        if (task === undefined || task.status === "cancelled" || task.status === "failed") {
          controller.abort();
        }
      }
    } catch {
      this.degradeStorage();
    }
  }

  private flushFailures(): void {
    if (this.store === undefined || this.pendingFailures.size === 0) {
      return;
    }
    try {
      for (const taskId of this.pendingFailures) {
        const persisted = this.store.fail(taskId, {
          code: -32603,
          message: "Task store is unavailable",
        });
        if (persisted !== undefined) {
          this.failedInMemory.set(taskId, toDetailedTask(persisted));
        }
        this.pendingFailures.delete(taskId);
      }
      if (this.active.size === 0) {
        clearInterval(this.cancellationTimer);
        this.cancellationTimer = undefined;
      }
    } catch {
      // Retry pending terminal states on the next existing cancellation poll
      // or request. Never restart runners after persistence recovers.
    }
  }

  private async run(
    taskId: string,
    controller: AbortController,
    runner: TaskRunner,
  ): Promise<void> {
    if (this.store === undefined) {
      return;
    }
    let lastProgressAt = 0;
    try {
      const result = await runner({
        signal: controller.signal,
        reportProgress: async (progress, total, message) => {
          if (message === undefined) {
            return;
          }
          const now = Date.now();
          const isFinal = total !== undefined && progress >= total;
          if (!isFinal && now - lastProgressAt < 250) {
            return;
          }
          lastProgressAt = now;
          this.store?.setStatusMessage(taskId, message);
          await Promise.resolve();
        },
      });
      if (!controller.signal.aborted && this.store.get(taskId)?.status !== "cancelled") {
        const bounded = boundResult(result, this.maxResultBytes);
        this.store.complete(taskId, bounded);
      }
    } catch {
      try {
        if (!controller.signal.aborted && this.store.get(taskId)?.status !== "cancelled") {
          this.store.fail(taskId, {
            code: -32603,
            message: "Task execution failed",
          });
        }
      } catch {
        this.degradeStorage();
      }
    } finally {
      this.active.delete(taskId);
      if (this.active.size === 0 && this.pendingFailures.size === 0) {
        clearInterval(this.cancellationTimer);
        this.cancellationTimer = undefined;
      }
    }
  }
}

export function createTaskManager(): TaskManager {
  const runtime = getTaskRuntimeConfig();
  if (!runtime.enabled) {
    return new TaskManager({ enabled: false, reason: "Disabled by MCP_TASKS" });
  }
  try {
    return new TaskManager({
      enabled: true,
      filePath: runtime.storeFilePath,
      ttlMs: runtime.ttlMs,
      pollIntervalMs: runtime.pollIntervalMs,
      maxResultBytes: runtime.maxResultBytes,
      maxActiveTasks: runtime.maxActiveTasks,
      toolNames: runtime.toolNames,
    });
  } catch {
    return new TaskManager({
      enabled: false,
      reason: "Task store is unavailable",
    });
  }
}

export type { TaskError };
