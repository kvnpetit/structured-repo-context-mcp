import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { isProcessAlive } from "./ownership";
import { retryTaskIo } from "./io";

const MAX_LOCK_WAIT_MS = 5_000;
const MAX_CONTENDERS = 1_024;
const waitCell = new Int32Array(new SharedArrayBuffer(4));

interface Contender {
  name: string;
  ticket: number;
}

function contenders(directory: string, deadline: number): Contender[] {
  const names = fs.readdirSync(directory);
  if (names.length > MAX_CONTENDERS) {
    throw new Error("Too many task store lock contenders");
  }
  const result: Contender[] = [];
  for (const name of names) {
    const match = /^(\d+)-[a-f0-9-]+\.json$/u.exec(name);
    if (match === null) {
      continue;
    }
    const filePath = path.join(directory, name);
    if (!isProcessAlive(Number(match[1]))) {
      // Every contender has a unique immutable filename. Removing a dead
      // process's entry cannot remove a lock acquired by its successor.
      retryTaskIo(() => {
        fs.rmSync(filePath, { force: true });
      }, deadline);
      continue;
    }
    try {
      const raw = retryTaskIo(() => fs.readFileSync(filePath, "utf8"), deadline);
      const ticket = Number(raw);
      result.push({
        name,
        ticket: raw.length > 0 && Number.isSafeInteger(ticket) && ticket > 0 ? ticket : 0,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return result;
}

/**
 * Local process mutual exclusion using Lamport's bakery algorithm. A zero
 * ticket means the contender is choosing. New arrivals choose a higher
 * ticket than existing holders; ties use the unique filename. No lock is
 * held across an await, and contention has a fixed timeout.
 */
export function withTaskStoreLock<T>(filePath: string, run: () => T): T {
  const directory = `${filePath}.locks`;
  const deadline = Date.now() + MAX_LOCK_WAIT_MS;
  fs.mkdirSync(directory, { recursive: true });
  const name = `${String(process.pid)}-${randomUUID()}.json`;
  const candidate = path.join(directory, name);
  fs.writeFileSync(candidate, "0", { flag: "wx" });
  try {
    const ticket = Math.max(0, ...contenders(directory, deadline).map((entry) => entry.ticket)) + 1;
    fs.writeFileSync(candidate, String(ticket));
    for (;;) {
      const blocked = contenders(directory, deadline).some(
        (entry) =>
          entry.name !== name &&
          (entry.ticket === 0 ||
            entry.ticket < ticket ||
            (entry.ticket === ticket && entry.name < name)),
      );
      if (!blocked) {
        return run();
      }
      if (Date.now() >= deadline) {
        throw new Error("Task store is busy");
      }
      Atomics.wait(waitCell, 0, 0, 10);
    }
  } finally {
    try {
      retryTaskIo(() => {
        fs.unlinkSync(candidate);
      });
    } catch {
      // A read-only/unavailable filesystem must not replace the original
      // error. Dead-process entries are reclaimed on a later operation.
    }
  }
}
