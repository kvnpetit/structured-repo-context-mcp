import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { getTaskRuntimeConfig, TaskManager } from "@core/tasks/manager";
import { DurableTaskStore } from "@core/tasks/store";

describe("task manager", () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function storePath(prefix: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    directories.push(directory);
    return path.join(directory, "tasks.json");
  }

  async function waitForStatus(
    manager: TaskManager,
    taskId: string,
    status: string,
  ): Promise<void> {
    await vi.waitFor(() => {
      expect(manager.getTask(taskId)?.status).toBe(status);
    });
  }

  test("runs a task and exposes its completed result", async () => {
    const manager = new TaskManager({
      enabled: true,
      filePath: storePath("tasks-manager-"),
      ttlMs: null,
      toolNames: ["test_tool"],
    });
    const task = manager.createTask("test_tool", async () => {
      await Promise.resolve();
      return {
        content: [{ type: "text", text: "completed" }],
        isError: false,
      };
    });

    expect(task.resultType).toBe("task");
    expect(task.status).toBe("working");
    await waitForStatus(manager, task.taskId, "completed");
    expect(manager.getTask(task.taskId)).toMatchObject({
      status: "completed",
      result: {
        content: [{ type: "text", text: "completed" }],
      },
    });
  });

  test("reports disabled managers and rejects task creation", () => {
    const manager = new TaskManager({
      enabled: false,
      reason: "disabled for test",
      toolNames: [],
    });

    expect(manager.canCreateTask("test_tool")).toBe(false);
    expect(manager.getTask("missing")).toBeUndefined();
    expect(manager.getStatus()).toMatchObject({
      enabled: false,
      reason: "disabled for test",
      activeTasks: 0,
    });
    expect(() =>
      manager.createTask("test_tool", async () => {
        await Promise.resolve();
        return {};
      }),
    ).toThrow("Task execution is not available");
  });

  test("parses defensive runtime configuration overrides", () => {
    vi.stubEnv("MCP_TASKS", "off");
    vi.stubEnv("MCP_TASK_STORE_DIR", "runtime-task-store");
    vi.stubEnv("MCP_TASK_TTL_MS", "unlimited");
    vi.stubEnv("MCP_TASK_POLL_INTERVAL_MS", "invalid");
    vi.stubEnv("MCP_TASK_MAX_ACTIVE", "0");
    vi.stubEnv("MCP_TASK_MAX_RESULT_BYTES", "0");
    vi.stubEnv("MCP_TASK_TOOLS", "one;; two");

    expect(getTaskRuntimeConfig()).toMatchObject({
      enabled: false,
      ttlMs: null,
      pollIntervalMs: 1000,
      maxActiveTasks: 8,
      maxResultBytes: 1024 * 1024,
      toolNames: ["one", "two"],
    });
  });

  test("turns an uncaught runner failure into a safe failed task", async () => {
    const manager = new TaskManager({
      enabled: true,
      filePath: storePath("tasks-error-"),
      ttlMs: null,
      toolNames: ["test_tool"],
    });
    const task = manager.createTask("test_tool", async () => {
      await Promise.resolve();
      throw new Error("private source path");
    });

    await waitForStatus(manager, task.taskId, "failed");
    expect(manager.getTask(task.taskId)).toMatchObject({
      status: "failed",
      error: { code: -32603, message: "Task execution failed" },
    });
  });

  test("cancels cooperatively and keeps cancellation terminal", async () => {
    const manager = new TaskManager({
      enabled: true,
      filePath: storePath("tasks-cancel-"),
      ttlMs: null,
      toolNames: ["test_tool"],
    });
    const task = manager.createTask(
      "test_tool",
      async ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("cancelled"));
            },
            {
              once: true,
            },
          );
          resolve({ ok: true });
        }),
    );

    expect(manager.cancelTask(task.taskId)).toBe(true);
    expect(manager.getTask(task.taskId)?.status).toBe("cancelled");
    await vi.waitFor(() => {
      expect(manager.getStatus().activeTasks).toBe(0);
    });
    expect(manager.getTask(task.taskId)?.status).toBe("cancelled");
  });

  test("validates input responses and records bounded progress", async () => {
    const filePath = storePath("tasks-input-");
    const persisted = new DurableTaskStore({ filePath, ttlMs: null });
    const persistedTask = persisted.create("test_tool");
    persisted.setInputRequired(persistedTask.taskId, {
      approval: { type: "boolean" },
    });

    const manager = new TaskManager({
      enabled: true,
      filePath,
      ttlMs: null,
      toolNames: ["test_tool"],
      recoverUnfinished: false,
    });
    expect(manager.updateTask(persistedTask.taskId, { unexpected: true })).toBe(true);
    expect(manager.getTask(persistedTask.taskId)?.status).toBe("input_required");
    expect(manager.updateTask(persistedTask.taskId, { approval: true })).toBe(true);
    expect(manager.getTask(persistedTask.taskId)?.status).toBe("working");
    expect(manager.updateTask("missing", {})).toBe(false);

    const task = manager.createTask("test_tool", async ({ reportProgress }) => {
      await reportProgress?.(1, 10, "started");
      await reportProgress?.(2, 10, "throttled");
      await reportProgress?.(10, 10, "finished");
      await reportProgress?.(0, undefined);
      return { value: 1n };
    });
    await waitForStatus(manager, task.taskId, "completed");
    expect(manager.getTask(task.taskId)).toMatchObject({
      status: "completed",
      statusMessage: "finished",
      result: { isError: true },
    });
  });

  test("cancels active runners when the owning manager closes", async () => {
    const manager = new TaskManager({
      enabled: true,
      filePath: storePath("tasks-close-"),
      ttlMs: null,
      toolNames: ["test_tool"],
    });
    const task = manager.createTask(
      "test_tool",
      async ({ signal }) =>
        new Promise<Record<string, unknown>>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve({ cancelled: true });
            },
            { once: true },
          );
        }),
    );

    manager.close();
    expect(manager.getTask(task.taskId)).toMatchObject({
      status: "cancelled",
      statusMessage: "Task cancelled because the server stopped",
    });
    await vi.waitFor(() => {
      expect(manager.getStatus().activeTasks).toBe(0);
    });
  });

  test("enforces the active task quota and unknown tool policy", () => {
    const manager = new TaskManager({
      enabled: true,
      filePath: storePath("tasks-quota-"),
      ttlMs: null,
      maxActiveTasks: 1,
      toolNames: ["test_tool"],
    });
    const task = manager.createTask(
      "test_tool",
      async ({ signal }) =>
        new Promise<Record<string, unknown>>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve({});
            },
            { once: true },
          );
        }),
    );

    expect(manager.canCreateTask("unknown_tool")).toBe(false);
    expect(manager.canCreateTask("test_tool")).toBe(false);
    expect(() =>
      manager.createTask("test_tool", async () => {
        await Promise.resolve();
        return {};
      }),
    ).toThrow();
    manager.cancelTask(task.taskId);
  });

  test("recovers unfinished persisted work as a protocol-level failure", () => {
    const filePath = storePath("tasks-recovery-");
    const store = new DurableTaskStore({ filePath, ttlMs: null });
    const task = store.create("test_tool");

    const restarted = new TaskManager({
      enabled: true,
      filePath,
      ttlMs: null,
      toolNames: ["test_tool"],
    });

    expect(restarted.getTask(task.taskId)).toMatchObject({
      status: "failed",
      statusMessage: "Task interrupted by server restart",
    });
  });

  test("bounds oversized persisted results", async () => {
    const manager = new TaskManager({
      enabled: true,
      filePath: storePath("tasks-limit-"),
      ttlMs: null,
      maxResultBytes: 32,
      toolNames: ["test_tool"],
    });
    const task = manager.createTask("test_tool", async () => {
      await Promise.resolve();
      return {
        content: [{ type: "text", text: "this result is deliberately large" }],
      };
    });

    await waitForStatus(manager, task.taskId, "completed");
    expect(manager.getTask(task.taskId)).toMatchObject({
      status: "completed",
      result: {
        isError: true,
        content: [
          {
            text: "Task result exceeded the configured storage limit and was rejected",
          },
        ],
      },
    });
  });
});
