import { afterEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { execute, findDeadCodeSchema } from "@features/find-dead-code";

describe("find_dead_code", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory !== undefined) {
      fs.rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  test("applies safe defaults", () => {
    const result = findDeadCodeSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(100);
      expect(result.data.max_files).toBe(500);
      expect(result.data.include_tests).toBe(false);
    }
  });

  test("reports unreferenced local symbols while preserving exports and references", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "dead-code-test-"));
    fs.writeFileSync(
      path.join(directory, "source.ts"),
      [
        "export function publicApi() { return used(); }",
        "function used() { return 1; }",
        "function unused() { return 2; }",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(directory, "source.test.ts"), "function testOnly() { return 1; }");

    const result = await execute({ directory });

    expect(result.success).toBe(true);
    const data = result.data as {
      candidates: { name: string; file_path: string }[];
      files_analyzed: number;
    };
    expect(data.files_analyzed).toBe(1);
    expect(data.candidates.map((candidate) => candidate.name)).toContain("unused");
    expect(data.candidates.map((candidate) => candidate.name)).not.toContain("used");
    expect(data.candidates.map((candidate) => candidate.name)).not.toContain("publicApi");
    expect(data.candidates.map((candidate) => candidate.name)).not.toContain("testOnly");
  });

  test("bounds candidate output and marks truncation", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "dead-code-limit-"));
    fs.writeFileSync(
      path.join(directory, "source.ts"),
      ["function first() {}", "function second() {}"].join("\n"),
    );

    const result = await execute({ directory, limit: 1 });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ truncated: true });
    expect((result.data as { candidates: unknown[] }).candidates).toHaveLength(1);
  });
});
