import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  hashCachePath,
  readHashCache,
  writeHashCache,
} from "@core/embeddings/hash-cache";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "src-mcp-hash-cache-"),
  );
  directories.push(directory);
  return directory;
}

describe("incremental hash cache", () => {
  test("writes deterministic, project-scoped entries", async () => {
    const directory = makeDirectory();
    const source = path.join(directory, "src", "main.ts");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "export const answer = 42;", "utf8");

    await writeHashCache(directory, {
      [source]: "a".repeat(64),
      [path.join(directory, "..", "outside.ts")]: "b".repeat(64),
      [path.join(directory, "invalid.ts")]: "bad value",
      "../relative.ts": "c".repeat(64),
    });

    const loaded = readHashCache(directory);
    expect(loaded).toMatchObject({ exists: true, valid: true });
    expect(loaded.cache).toEqual({ [path.resolve(source)]: "a".repeat(64) });
    expect(
      JSON.parse(fs.readFileSync(hashCachePath(directory), "utf8")),
    ).toEqual({ [path.resolve(source)]: "a".repeat(64) });
  });

  test("marks tampered entries invalid without trusting them", () => {
    const directory = makeDirectory();
    const cachePath = hashCachePath(directory);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        [path.join(directory, "safe.ts")]: "d".repeat(64),
        [path.join(directory, "..", "outside.ts")]: "e".repeat(64),
      }),
      "utf8",
    );

    const loaded = readHashCache(directory);
    expect(loaded.exists).toBe(true);
    expect(loaded.valid).toBe(false);
    expect(loaded.cache).toEqual({
      [path.join(directory, "safe.ts")]: "d".repeat(64),
    });
  });
});
