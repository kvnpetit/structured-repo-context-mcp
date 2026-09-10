import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  localStateRelativePath,
  readLocalState,
  withLocalStateLock,
  writeLocalState,
} from "@core/local-state";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("local project state", () => {
  test("reads missing state and writes a bounded atomic state file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-state-"));
    directories.push(directory);

    expect(readLocalState(directory, "state.json")).toEqual({
      ok: true,
      exists: false,
    });
    writeLocalState(directory, "state.json", { version: 1, value: "ok" });
    expect(readLocalState(directory, "state.json")).toEqual({
      ok: true,
      exists: true,
      value: { version: 1, value: "ok" },
    });
    expect(fs.readdirSync(path.join(directory, ".src-index"))).toEqual(["state.json"]);
    expect(localStateRelativePath("state.json")).toBe(".src-index/state.json");
  });

  test("fails closed for a symlinked state directory", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-state-"));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-state-target-"));
    directories.push(directory, target);
    fs.symlinkSync(target, path.join(directory, ".src-index"), "junction");

    expect(readLocalState(directory, "state.json")).toMatchObject({
      ok: false,
    });
    expect(() => {
      writeLocalState(directory, "state.json", {});
    }).toThrow("Local state directory is not a regular directory");
  });

  test("holds a cross-process lock while mutating local state", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-state-"));
    directories.push(directory);

    await withLocalStateLock(directory, "state.json", () => {
      expect(fs.existsSync(path.join(directory, ".src-index", "state.json.lock"))).toBe(true);
      writeLocalState(directory, "state.json", { version: 1 });
    });

    expect(fs.existsSync(path.join(directory, ".src-index", "state.json.lock"))).toBe(false);
  });
});
