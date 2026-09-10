import type { TaskOwner } from "./ownership";

export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks" as const;

export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export interface TaskError {
  code: number;
  message: string;
  data?: unknown;
}

export interface StoredTask {
  owner?: TaskOwner;
  taskId: string;
  toolName: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  inputRequests?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: TaskError;
}

export interface PublicTask {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
}

export type DetailedTask =
  | (PublicTask & { status: "working" })
  | (PublicTask & {
      status: "input_required";
      inputRequests: Record<string, unknown>;
    })
  | (PublicTask & { status: "completed"; result: Record<string, unknown> })
  | (PublicTask & { status: "failed"; error: TaskError })
  | (PublicTask & { status: "cancelled" });

export interface CreateTaskResult extends PublicTask {
  resultType: "task";
}

export interface TaskRuntimeConfig {
  enabled: boolean;
  storeFilePath: string;
  ttlMs: number | null;
  pollIntervalMs: number;
  maxResultBytes: number;
  maxActiveTasks: number;
  toolNames: string[];
}
