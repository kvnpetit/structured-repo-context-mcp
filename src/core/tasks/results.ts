import type {
  CreateTaskResult,
  DetailedTask,
  PublicTask,
  StoredTask,
} from "./types";

export function toPublicTask(task: StoredTask): PublicTask {
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

export function toCreateTaskResult(task: StoredTask): CreateTaskResult {
  return { resultType: "task", ...toPublicTask(task) };
}

export function toDetailedTask(task: StoredTask): DetailedTask {
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

export function boundResult(
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
