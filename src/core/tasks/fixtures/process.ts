import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { TaskManager } from "../manager";
import { withTaskStoreLock } from "../locking";

const [filePath, mode] = process.argv.slice(2);
if (filePath === undefined) {
  throw new Error("A fixture store is required");
}

const manager = new TaskManager({
  filePath,
  ttlMs: null,
  toolNames: ["fixture"],
  maxActiveTasks: 40,
});
const report = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

if (mode === "crash-choose") {
  fs.mkdirSync(`${filePath}.locks`, { recursive: true });
  fs.writeFileSync(`${filePath}.locks/${String(process.pid)}-${randomUUID()}.json`, "0");
  process.exit(17);
} else if (mode === "crash-write") {
  withTaskStoreLock(filePath, () => {
    fs.writeFileSync(`${filePath}.${String(process.pid)}.${randomUUID()}.tmp`, '{"partial":');
    process.exit(17);
  });
} else if (mode === "batch") {
  const ids: string[] = [];
  for (let index = 0; index < 24; index += 1) {
    const task = manager.createTask("fixture", async ({ reportProgress }) => {
      await delay(index % 4);
      await reportProgress?.(1, 1, "finished");
      return { index };
    });
    ids.push(task.taskId);
  }
  while (manager.getStatus().activeTasks > 0) {
    await delay(10);
  }
  report({ ids });
  manager.close();
} else {
  let finish: (() => void) | undefined;
  const task = manager.createTask("fixture", async ({ signal }) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
      signal.addEventListener(
        "abort",
        () => {
          resolve();
        },
        { once: true },
      );
    });
    return { completed: true };
  });
  if (mode === "storage-recovery") {
    const locks = `${filePath}.locks`;
    fs.rmdirSync(locks);
    fs.writeFileSync(locks, "unavailable locks");
    manager.getStatus();
    fs.unlinkSync(locks);
    fs.mkdirSync(locks);
    report({ taskId: task.taskId });
    await new Promise<void>((resolve) => {
      process.stdin.once("data", () => {
        resolve();
      });
    });
    manager.close();
    process.stdin.destroy();
  } else if (mode === "storage-failure") {
    fs.unlinkSync(filePath);
    fs.rmdirSync(`${filePath}.locks`);
    fs.rmdirSync(path.dirname(filePath));
    fs.writeFileSync(path.dirname(filePath), "unavailable store");
    finish?.();
    await delay(30);
    report({
      task: manager.getTask(task.taskId),
      status: manager.getStatus(),
      canCreate: manager.canCreateTask("fixture"),
    });
    manager.close();
    fs.unlinkSync(path.dirname(filePath));
  } else {
    report({ taskId: task.taskId });
    process.stdin.once("data", () => finish?.());
    // Keep the live fixture available even when its task is remotely cancelled.
    const keepAlive = setInterval(() => undefined, 1000);
    while (manager.getStatus().activeTasks > 0) {
      await delay(20);
    }
    clearInterval(keepAlive);
    report({ status: manager.getTask(task.taskId)?.status });
    manager.close();
    process.stdin.destroy();
  }
}
