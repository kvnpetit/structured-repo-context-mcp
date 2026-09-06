import * as os from "node:os";
import * as path from "node:path";

import type { FeatureExecutionContext } from "@features/types";

import {
  DurableTaskStore,
  DEFAULT_MAX_RESULT_BYTES,
  type TaskStoreOptions,
} from "@core/tasks/store";
import type {
  CreateTaskResult,
  DetailedTask,
  PublicTask,
  StoredTask,
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

export type TaskRunner = (
  context: TaskRunnerContext,
) => Promise<Record<string, unknown>>;

function isDisabled(value: string | undefined): boolean {
  return (
    value !== undefined && /^(?:0|false|off|disabled|no)$/iu.test(value.trim())
  );
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTtl(): number | null {
  const raw = process.env.MCP_TASK_TTL_MS?.trim();
  if (raw === "none" || raw === "unlimited") {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : 24 * 60 * 60 * 1000;
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
    configuredStoreDirectory === undefined ||
    configuredStoreDirectory.length === 0
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
    pollIntervalMs: parsePositiveInteger(
      process.env.MCP_TASK_POLL_INTERVAL_MS,
      1000,
    ),
    maxResultBytes,
    maxActiveTasks: parsePositiveInteger(
      process.env.MCP_TASK_MAX_ACTIVE,
      DEFAULT_MAX_ACTIVE_TASKS,
    ),
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

  constructor(options: TaskManagerOptions = {}) {
    const runtime = getTaskRuntimeConfig();
    this.enabled = options.enabled ?? runtime.enabled;
    this.reason = options.reason;
    this.maxResultBytes = options.maxResultBytes ?? runtime.maxResultBytes;
    this.maxActiveTasks = options.maxActiveTasks ?? runtime.maxActiveTasks;
    this.toolNames = new Set(options.toolNames ?? runtime.toolNames);
    if (this.enabled) {
      this.store = new DurableTaskStore({
        filePath: options.filePath ?? runtime.storeFilePath,
        ttlMs: options.ttlMs !== undefined ? options.ttlMs : runtime.ttlMs,
        pollIntervalMs: options.pollIntervalMs ?? runtime.pollIntervalMs,
      });
      if (options.recoverUnfinished !== false) {
        this.store.markUnfinishedAsFailed();
      }
    }
  }

  canCreateTask(toolName: string): boolean {
    return (
      this.enabled &&
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
    void this.run(stored.taskId, controller, runner);
    return toCreateTaskResult(stored);
  }

  getTask(taskId: string): DetailedTask | undefined {
    const task = this.store?.get(taskId);
    return task === undefined ? undefined : toDetailedTask(task);
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
      const hasKnownResponse = Object.keys(inputResponses).some((key) =>
        outstanding.has(key),
      );
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
    this.store?.cancel(taskId);
    this.active.get(taskId)?.abort();
    return true;
  }

  /** Stop active runners when an owning server/HTTP listener is shutting down. */
  close(): void {
    for (const [taskId, controller] of this.active) {
      this.store?.cancel(taskId, "Task cancelled because the server stopped");
      controller.abort();
    }
  }

  getStatus(): TaskManagerStatus {
    return {
      enabled: this.enabled,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      activeTasks: this.active.size,
      maxActiveTasks: this.maxActiveTasks,
      configuredTools: [...this.toolNames],
      counts: this.store?.counts() ?? {
        working: 0,
        input_required: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      },
    };
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
      if (
        !controller.signal.aborted &&
        this.store.get(taskId)?.status !== "cancelled"
      ) {
        const bounded = boundResult(result, this.maxResultBytes);
        this.store.complete(taskId, bounded);
      }
    } catch {
      if (
        !controller.signal.aborted &&
        this.store.get(taskId)?.status !== "cancelled"
      ) {
        this.store.fail(taskId, {
          code: -32603,
          message: "Task execution failed",
        });
      }
    } finally {
      this.active.delete(taskId);
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
      reason: "Task store is not writable",
    });
  }
}

function toPublicTask(task: StoredTask): PublicTask {
  return {
    taskId: task.taskId,
    status: task.status,
    ...(task.statusMessage === undefined
      ? {}
      : { statusMessage: task.statusMessage }),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    ...(task.pollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: task.pollIntervalMs }),
  };
}

function toCreateTaskResult(task: StoredTask): CreateTaskResult {
  return { resultType: "task", ...toPublicTask(task) };
}

function toDetailedTask(task: StoredTask): DetailedTask {
  const base = toPublicTask(task);
  if (task.status === "input_required") {
    return {
      ...base,
      status: "input_required",
      inputRequests: task.inputRequests ?? {},
    };
  }
  if (task.status === "completed") {
    return { ...base, status: "completed", result: task.result ?? {} };
  }
  if (task.status === "failed") {
    return {
      ...base,
      status: "failed",
      error: task.error ?? { code: -32603, message: "Task execution failed" },
    };
  }
  if (task.status === "cancelled") {
    return { ...base, status: "cancelled" };
  }
  return { ...base, status: "working" };
}

function boundResult(
  result: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    return {
      content: [{ type: "text", text: "Task result could not be serialized" }],
      isError: true,
    };
  }
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) {
    return result;
  }
  return {
    content: [
      {
        type: "text",
        text: "Task result exceeded the configured storage limit and was rejected",
      },
    ],
    isError: true,
  };
}

export type { TaskError };
