import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { DurableTaskStore } from "@core/tasks/store";
import { createTaskManager } from "@core/tasks/manager";

describe("durable task store", () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function filePath(prefix: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    directories.push(directory);
    return path.join(directory, "tasks.json");
  }

  test("persists task state through an atomic snapshot", () => {
    const storePath = filePath("tasks-store-");
    const first = new DurableTaskStore({
      filePath: storePath,
      ttlMs: null,
      pollIntervalMs: 250,
    });
    const task = first.create("index_codebase");
    first.complete(task.taskId, { content: [{ type: "text", text: "done" }] });

    const second = new DurableTaskStore({ filePath: storePath, ttlMs: null });
    expect(second.get(task.taskId)).toMatchObject({
      taskId: task.taskId,
      status: "completed",
      result: { content: [{ type: "text", text: "done" }] },
    });
    expect(second.get(task.taskId)?.pollIntervalMs).toBe(250);
  });

  test("enforces the lifecycle and ignores terminal rewrites", () => {
    const store = new DurableTaskStore({
      filePath: filePath("tasks-life-"),
      ttlMs: null,
    });
    const task = store.create("test_tool");

    expect(
      store.setInputRequired(task.taskId, { confirm: { type: "boolean" } })
        ?.status,
    ).toBe("input_required");
    expect(store.markWorking(task.taskId)?.status).toBe("working");
    expect(store.complete(task.taskId, { ok: true })?.status).toBe("completed");
    expect(store.cancel(task.taskId)?.status).toBe("completed");
    expect(store.get(task.taskId)?.result).toEqual({ ok: true });
  });

  test("purges expired tasks without exposing stale state", () => {
    const store = new DurableTaskStore({
      filePath: filePath("tasks-ttl-"),
      ttlMs: 0,
    });
    const task = store.create("test_tool");

    expect(store.get(task.taskId)).toBeUndefined();
    expect(store.counts()).toEqual({
      working: 0,
      input_required: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    });
  });

  test("preserves malformed snapshots and disables tasks without preventing server startup", () => {
    const storePath = filePath("tasks-corrupt-");
    fs.writeFileSync(storePath, "not-json", "utf8");

    expect(
      () => new DurableTaskStore({ filePath: storePath, ttlMs: null }),
    ).toThrow();
    vi.stubEnv("MCP_TASK_STORE_DIR", path.dirname(storePath));
    expect(createTaskManager().getStatus()).toMatchObject({
      enabled: false,
      reason: "Task store is unavailable",
    });
    expect(fs.readFileSync(storePath, "utf8")).toBe("not-json");
  });

  test("loads only valid task records and fails unfinished records safely", () => {
    const storePath = filePath("tasks-validation-");
    const now = new Date().toISOString();
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        tasks: {
          working: {
            taskId: "working",
            toolName: "test_tool",
            status: "working",
            createdAt: now,
            lastUpdatedAt: now,
            ttlMs: null,
          },
          input: {
            taskId: "input",
            toolName: "test_tool",
            status: "input_required",
            createdAt: now,
            lastUpdatedAt: now,
            ttlMs: 60_000,
          },
          failed: {
            taskId: "failed",
            toolName: "test_tool",
            status: "failed",
            createdAt: now,
            lastUpdatedAt: now,
            ttlMs: null,
          },
          cancelled: {
            taskId: "cancelled",
            toolName: "test_tool",
            status: "cancelled",
            createdAt: now,
            lastUpdatedAt: now,
            ttlMs: null,
          },
          invalid: { taskId: "invalid", status: "not-a-status" },
          mismatch: {
            taskId: "other",
            toolName: "test_tool",
            status: "completed",
            createdAt: now,
            lastUpdatedAt: now,
            ttlMs: null,
          },
          nullEntry: null,
        },
      }),
      "utf8",
    );

    expect(
      () => new DurableTaskStore({ filePath: storePath, ttlMs: null }),
    ).toThrow("corrupt task record");
    const snapshot = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
      tasks: Record<string, unknown>;
    };
    delete snapshot.tasks.invalid;
    delete snapshot.tasks.mismatch;
    delete snapshot.tasks.nullEntry;
    fs.writeFileSync(storePath, JSON.stringify(snapshot));
    const store = new DurableTaskStore({ filePath: storePath, ttlMs: null });

    expect(store.get("working")?.status).toBe("working");
    expect(store.get("input")?.status).toBe("input_required");
    expect(store.get("failed")?.status).toBe("failed");
    expect(store.get("cancelled")?.status).toBe("cancelled");
    expect(store.get("invalid")).toBeUndefined();
    expect(store.get("mismatch")).toBeUndefined();
    expect(store.markUnfinishedAsFailed()).toBe(2);
    expect(store.get("working")?.status).toBe("failed");
    expect(store.get("input")?.status).toBe("failed");
    expect(store.markUnfinishedAsFailed()).toBe(0);
  });

  test("bounds status messages and handles missing or terminal transitions", () => {
    const store = new DurableTaskStore({
      filePath: filePath("tasks-status-"),
      ttlMs: null,
      pollIntervalMs: 0,
    });
    const task = store.create("test_tool");

    expect(store.setStatusMessage("missing", "ignored")).toBeUndefined();
    expect(store.setInputRequired("missing", {})).toBeUndefined();
    expect(store.markWorking("missing")).toBeUndefined();
    expect(
      store.setStatusMessage(task.taskId, "x".repeat(600))?.statusMessage,
    ).toHaveLength(500);
    expect(store.setInputRequired(task.taskId, { confirm: true })?.status).toBe(
      "input_required",
    );
    expect(store.setInputRequired(task.taskId, {})?.status).toBe(
      "input_required",
    );
    expect(store.complete(task.taskId, { ok: true })?.status).toBe("completed");
    expect(
      store.setStatusMessage(task.taskId, "late")?.statusMessage,
    ).toHaveLength(500);
    expect(store.markWorking(task.taskId)?.status).toBe("completed");
  });

  test("uses defensive environment defaults and rejects invalid timestamps", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-env-"));
    directories.push(directory);
    vi.stubEnv("MCP_TASK_STORE_DIR", directory);
    vi.stubEnv("MCP_TASK_TTL_MS", "invalid");
    vi.stubEnv("MCP_TASK_POLL_INTERVAL_MS", "invalid");

    const store = new DurableTaskStore({ pollIntervalMs: 0 });
    expect(store.filePath).toBe(path.join(directory, "tasks.json"));
    expect(store.ttlMs).toBe(24 * 60 * 60 * 1000);
    expect(store.pollIntervalMs).toBe(1000);

    const invalidTimestampPath = filePath("tasks-time-");
    const task = {
      taskId: "invalid-date",
      toolName: "test_tool",
      status: "completed",
      createdAt: "not-a-date",
      lastUpdatedAt: "not-a-date",
      ttlMs: 1,
    };
    fs.writeFileSync(
      invalidTimestampPath,
      JSON.stringify({ version: 1, tasks: { [task.taskId]: task } }),
      "utf8",
    );
    expect(
      () =>
        new DurableTaskStore({
          filePath: invalidTimestampPath,
          ttlMs: 1,
        }),
    ).toThrow("corrupt task record");
  });
});
