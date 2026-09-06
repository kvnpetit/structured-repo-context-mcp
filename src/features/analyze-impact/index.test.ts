import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execute } from "@features/analyze-impact";

describe("analyze_impact", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-impact-test-"));
    fs.writeFileSync(
      path.join(directory, "a.ts"),
      'import { b } from "./b"; export const a = b;\n',
    );
    fs.writeFileSync(
      path.join(directory, "b.ts"),
      'import { c } from "./c"; export const b = c;\n',
    );
    fs.writeFileSync(path.join(directory, "c.ts"), "export const c = 1;\n");
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("computes direct and transitive reverse dependents", async () => {
    const result = await execute({
      directory,
      changed_files: ["c.ts"],
      max_files: 10,
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      directly_impacted: string[];
      transitively_impacted: string[];
    };
    expect(data.directly_impacted).toContain("b.ts");
    expect(data.transitively_impacted).toContain("a.ts");
  });
});
