import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import { TaskManager } from "./manager";
import { DurableTaskStore } from "./store";
import { MAX_STORED_TASKS, writeTaskState } from "./persistence";

interface Fixture {
  child: ChildProcessWithoutNullStreams;
  messages: Record<string, unknown>[];
  done: Promise<{ code: number | null; stderr: string }>;
}

describe("task persistence across local processes", () => {
  const directories: string[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const managers: TaskManager[] = [];

  afterEach(async () => {
    for (const manager of managers.splice(0)) {
      manager.close();
    }
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) =>
          child.once("exit", () => {
            resolve();
          }),
        );
        child.kill();
        await exited;
      }
    }
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function storePath(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-concurrency-"));
    directories.push(directory);
    return path.join(directory, "tasks.json");
  }

  function start(filePath: string, mode: string): Fixture {
    const fixture = fileURLToPath(new URL("./fixtures/process.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", fixture, filePath, mode], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(child);
    const messages: Record<string, unknown>[] = [];
    let output = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      while (true) {
        const newline = output.indexOf("\n");
        if (newline < 0) {
          break;
        }
        messages.push(JSON.parse(output.slice(0, newline)) as Record<string, unknown>);
        output = output.slice(newline + 1);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({ code, stderr });
      });
    });
    return { child, messages, done };
  }

  async function taskId(fixture: Fixture): Promise<string> {
    await vi.waitFor(
      () => {
        expect(fixture.messages[0]?.taskId).toBeTypeOf("string");
      },
      { timeout: 15_000 },
    );
    return fixture.messages[0]?.taskId as string;
  }

  test("keeps every result when two real processes create and finish concurrently", async () => {
    const filePath = storePath();
    const expired = new DurableTaskStore({ filePath, ttlMs: 0 }).create("expired");
    const first = start(filePath, "batch");
    const second = start(filePath, "batch");
    const results = await Promise.all([first.done, second.done]);
    expect(results).toEqual([
      { code: 0, stderr: "" },
      { code: 0, stderr: "" },
    ]);
    const firstMessage = first.messages[0];
    const secondMessage = second.messages[0];
    if (firstMessage === undefined || secondMessage === undefined) {
      throw new Error("The process fixtures did not return their task IDs");
    }
    const ids = [...(firstMessage.ids as string[]), ...(secondMessage.ids as string[])];
    const reloaded = new DurableTaskStore({ filePath });
    expect(new Set(ids).size).toBe(48);
    expect(
      ids.map((id) => reloaded.get(id)).filter((task) => task?.status !== "completed"),
    ).toEqual([]);
    expect(reloaded.counts().completed).toBe(48);
    expect(reloaded.get(expired.taskId)).toBeUndefined();
    for (const id of ids) {
      expect(reloaded.get(id)?.status).toBe("completed");
    }
  }, 40_000);

  test("preserves live owners, shares cancellation, and recovers only the dead owner", async () => {
    const filePath = storePath();
    const first = start(filePath, "live");
    const firstId = await taskId(first);
    const second = start(filePath, "live");
    const secondId = await taskId(second);
    const observer = new TaskManager({ filePath, ttlMs: null });
    managers.push(observer);
    expect(observer.getTask(firstId)?.status).toBe("working");
    expect(observer.getTask(secondId)?.status).toBe("working");
    first.child.kill();
    await first.done;
    expect(observer.getTask(firstId)?.status).toBe("failed");
    expect(observer.getTask(secondId)?.status).toBe("working");
    expect(observer.cancelTask(secondId)).toBe(true);
    expect(await second.done).toEqual({ code: 0, stderr: "" });
    expect(second.messages[1]?.status).toBe("cancelled");
  }, 40_000);

  test("reclaims a crashed writer's lock and partial file without losing the previous snapshot", async () => {
    const filePath = storePath();
    const store = new DurableTaskStore({ filePath, ttlMs: null });
    const task = store.create("fixture");
    store.complete(task.taskId, { beforeCrash: true });
    for (const mode of ["crash-choose", "crash-write"]) {
      const crashed = start(filePath, mode);
      expect((await crashed.done).code).toBe(17);
      const restarted = new DurableTaskStore({ filePath });
      expect(restarted.get(task.taskId)?.result).toEqual({ beforeCrash: true });
      expect(fs.readdirSync(`${filePath}.locks`)).toEqual([]);
      expect(
        fs.readdirSync(path.dirname(filePath)).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
    }
  }, 20_000);

  test("survives unavailable persistence without an unhandled rejection", async () => {
    const fixture = start(storePath(), "storage-failure");
    expect(await fixture.done).toEqual({ code: 0, stderr: "" });
    expect(fixture.messages[0]).toMatchObject({
      task: {
        status: "failed",
        error: { message: "Task store is unavailable" },
      },
      status: { activeTasks: 0, reason: "Task store is unavailable" },
      canCreate: false,
    });
  }, 20_000);

  test("persists remembered failures after I/O recovers while the owner stays alive", async () => {
    const filePath = storePath();
    const fixture = start(filePath, "storage-recovery");
    const id = await taskId(fixture);
    const observer = new TaskManager({ filePath, ttlMs: null });
    managers.push(observer);
    await vi.waitFor(
      () => {
        expect(observer.getTask(id)).toMatchObject({
          status: "failed",
          error: { message: "Task store is unavailable" },
        });
      },
      { timeout: 5_000 },
    );
    expect(fixture.child.exitCode).toBeNull();
    fixture.child.stdin.write("stop");
    expect(await fixture.done).toEqual({ code: 0, stderr: "" });
  }, 20_000);

  test("rejects a snapshot above the byte limit before replacing valid state", () => {
    const filePath = storePath();
    const store = new DurableTaskStore({ filePath, ttlMs: null });
    const task = store.create("fixture");
    store.complete(task.taskId, { preserved: true });
    const oversized = new Map([
      [task.taskId, { ...task, result: { text: "x".repeat(16 * 1024 * 1024) } }],
    ]);
    expect(() => {
      writeTaskState(filePath, oversized);
    }).toThrow("storage limit");
    expect(store.get(task.taskId)?.result).toEqual({ preserved: true });
  });

  test("refuses new tasks at capacity without deleting retained handles", () => {
    const filePath = storePath();
    const store = new DurableTaskStore({ filePath, ttlMs: null });
    const original = store.create("fixture");
    const tasks = new Map(
      Array.from({ length: MAX_STORED_TASKS }, (_, index) => {
        const taskId = `task-${String(index)}`;
        return [taskId, { ...original, taskId }] as const;
      }),
    );
    writeTaskState(filePath, tasks);
    expect(() => store.create("extra")).toThrow("full");
    expect(store.counts().working).toBe(MAX_STORED_TASKS);
    expect(store.get("task-0")).toBeDefined();
  });
});
