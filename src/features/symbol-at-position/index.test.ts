import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { execute, symbolAtPositionSchema } from "@features/symbol-at-position";

describe("get_symbol_at_position", () => {
  test("validates required file position and applies source defaults", () => {
    const missing = symbolAtPositionSchema.safeParse({});
    expect(missing.success).toBe(false);

    const valid = symbolAtPositionSchema.safeParse({
      file_path: "src/index.ts",
      line: 1,
      column: 0,
    });
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data.include_source).toBe(true);
      expect(valid.data.max_source_bytes).toBe(20_000);
    }
  });

  test("resolves the smallest containing symbol with byte-precise source", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-symbol-"));
    try {
      const filePath = path.join(directory, "service.ts");
      fs.writeFileSync(
        filePath,
        "const café = 1;\nexport class Service {\n  run() { return café; }\n}\n",
      );

      const result = await execute({
        directory,
        file_path: "service.ts",
        line: 3,
        column: 8,
      });

      expect(result.success).toBe(true);
      const data = result.data as {
        found: boolean;
        position: { offset: number };
        symbol: {
          name: string;
          type: string;
          source?: string;
          start: { line: number };
        } | null;
      };
      expect(data.found).toBe(true);
      expect(data.position.offset).toBeGreaterThan(0);
      expect(data.symbol?.name).toBe("run");
      expect(data.symbol?.type).toBe("method");
      expect(data.symbol?.start.line).toBe(3);
      expect(data.symbol?.source).toContain("return café");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("returns a bounded source body and reports positions outside the file", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "src-symbol-limit-"),
    );
    try {
      fs.writeFileSync(
        path.join(directory, "large.ts"),
        "export function large() {\n" +
          '  return "' +
          "x".repeat(500) +
          '";\n}\n',
      );
      const bounded = await execute({
        directory,
        file_path: "large.ts",
        line: 2,
        column: 2,
        max_source_bytes: 20,
      });
      expect(bounded.success).toBe(true);
      const boundedData = bounded.data as {
        symbol: { source?: string; source_truncated?: boolean } | null;
      };
      expect(boundedData.symbol?.source_truncated).toBe(true);
      expect(Buffer.byteLength(boundedData.symbol?.source ?? "", "utf8")).toBe(
        20,
      );

      const outside = await execute({
        directory,
        file_path: "large.ts",
        line: 99,
        column: 0,
      });
      expect(outside.success).toBe(false);
      expect(outside.error).toBe("Position is outside the file");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
