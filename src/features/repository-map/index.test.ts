import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { execute, repositoryMapSchema } from "@features/repository-map";

describe("repository map", () => {
  test("validates and defaults the bounded orientation request", () => {
    const result = repositoryMapSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_tokens).toBe(2_000);
      expect(result.data.max_files).toBe(500);
      expect(result.data.focus).toEqual([]);
    }
  });

  test("renders an import-ranked map and honors focus", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-map-"));
    try {
      fs.writeFileSync(
        path.join(directory, "entry.ts"),
        'import { service } from "./service";\nexport function main() { return service(); }\n',
      );
      fs.writeFileSync(
        path.join(directory, "service.ts"),
        "export function service() { return 42; }\n",
      );
      fs.mkdirSync(path.join(directory, "tests"));
      fs.writeFileSync(
        path.join(directory, "tests", "service.test.ts"),
        'import { service } from "../service";\nservice();\n',
      );

      const result = await execute({
        directory,
        focus: ["service"],
        max_tokens: 500,
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("Repository map");
      const data = result.data as {
        files_analyzed: number;
        files_included: number;
        truncated: boolean;
        map: string;
        ranked_files: { path: string }[];
      };
      expect(data.files_analyzed).toBe(3);
      expect(data.files_included).toBe(3);
      expect(data.truncated).toBe(false);
      expect(data.map).toContain("service.ts [typescript]");
      expect(data.map).toContain("function service");
      expect(data.ranked_files[0]?.path).toBe("service.ts");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reports truncation instead of returning an unbounded map", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-map-small-"));
    try {
      fs.writeFileSync(
        path.join(directory, "large.ts"),
        Array.from(
          { length: 40 },
          (_, index) => `export function function${String(index)}() { return ${String(index)}; }`,
        ).join("\n"),
      );

      const result = await execute({ directory, max_tokens: 10 });
      expect(result.success).toBe(true);
      const data = result.data as {
        truncated: boolean;
        estimated_tokens: number;
      };
      expect(data.truncated).toBe(true);
      expect(data.estimated_tokens).toBeLessThanOrEqual(10);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
