import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { writeJsonAtomically, writeTextAtomically } from "@core/utils";

describe("atomic local state writers", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("creates parent directories and replaces text content", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-test-"));
    directories.push(directory);
    const filePath = path.join(directory, "nested", "state.txt");

    writeTextAtomically(filePath, "first");
    writeTextAtomically(filePath, "second");

    expect(fs.readFileSync(filePath, "utf8")).toBe("second");
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(["state.txt"]);
  });

  test("writes valid JSON through the same replacement path", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-json-"));
    directories.push(directory);
    const filePath = path.join(directory, "state.json");

    writeJsonAtomically(filePath, { version: 1, ready: true });

    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      version: 1,
      ready: true,
    });
  });
});
