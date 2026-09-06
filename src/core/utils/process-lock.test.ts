import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { withProcessFileLock } from "@core/utils";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("local process lock", () => {
  test("serializes concurrent writers and removes the lock", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-lock-"));
    directories.push(directory);
    const lockPath = path.join(directory, "index.lock");
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withProcessFileLock(
      lockPath,
      async () => {
        events.push("first-start");
        await firstRelease;
        events.push("first-end");
      },
      { timeoutMs: 2_000, staleMs: 100 },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = withProcessFileLock(
      lockPath,
      () => {
        events.push("second");
      },
      { timeoutMs: 2_000, staleMs: 100 },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("recovers an abandoned lock", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-lock-"));
    directories.push(directory);
    const lockPath = path.join(directory, "index.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999_999, token: "abandoned", created_at: "" }),
    );
    const old = new Date(Date.now() - 5_000);
    fs.utimesSync(lockPath, old, old);

    await withProcessFileLock(lockPath, () => undefined, {
      timeoutMs: 1_000,
      staleMs: 10,
    });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("recovers an oversized stale lock without parsing an unbounded file", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-lock-"));
    directories.push(directory);
    const lockPath = path.join(directory, "index.lock");
    fs.writeFileSync(lockPath, "x".repeat(4 * 1024 + 1));
    const old = new Date(Date.now() - 5_000);
    fs.utimesSync(lockPath, old, old);

    await withProcessFileLock(lockPath, () => undefined, {
      timeoutMs: 1_000,
      staleMs: 10,
    });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("uses safe defaults for invalid timing options", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-lock-"));
    directories.push(directory);
    const lockPath = path.join(directory, "index.lock");

    await withProcessFileLock(lockPath, () => "ok", {
      timeoutMs: Number.NaN,
      staleMs: Number.POSITIVE_INFINITY,
    });
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
