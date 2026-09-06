import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { execute as importScip, scipImportSchema } from "@features/scip-import";
import { execute as navigate } from "@features/semantic-navigation";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function payload(): string {
  return JSON.stringify({
    documents: [
      {
        relative_path: "module.ts",
        language: "TypeScript",
        occurrences: [
          {
            range: [0, 16, 22],
            symbol: "scip-typescript npm com.example/target.",
            symbol_roles: 1,
          },
          {
            range: [5, 9, 15],
            symbol: "scip-typescript npm com.example/target.",
            symbol_roles: 8,
          },
        ],
        symbols: [
          {
            symbol: "scip-typescript npm com.example/target.",
            documentation: ["Returns the incremented value."],
            kind: "function",
          },
        ],
      },
    ],
  });
}

describe("import_scip_index", () => {
  test("validates local JSON import defaults", () => {
    const parsed = scipImportSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.index_file).toBe("index.scip");
      expect(parsed.data.format).toBe("auto");
    }
  });

  test("imports a SCIP JSON export and powers semantic navigation", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-scip-"));
    directories.push(directory);
    fs.writeFileSync(
      path.join(directory, "module.ts"),
      [
        "export function target(value: number): number {",
        "  return value + 1;",
        "}",
        "",
        "export function caller(): number {",
        "  return target(41);",
        "}",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(directory, "index.scip"), payload());

    const imported = await importScip({
      directory,
      index_file: "index.scip",
      format: "json",
    });
    expect(imported.success).toBe(true);
    if (!imported.success) {
      return;
    }
    expect(imported.data).toMatchObject({
      documents: 1,
      occurrences: 2,
      symbols: 1,
    });

    const navigation = await navigate({
      directory,
      file_path: "module.ts",
      line: 1,
      column: 16,
      operation: "definition",
      backend: "scip",
    });
    expect(navigation.success).toBe(true);
    if (navigation.success) {
      expect(navigation.data).toMatchObject({
        backend_used: "scip",
        coverage: "precise",
      });
      expect(
        (navigation.data as { locations: { start: { line: number } }[] })
          .locations[0]?.start.line,
      ).toBe(1);
    }

    const hover = await navigate({
      directory,
      file_path: "module.ts",
      line: 1,
      column: 16,
      operation: "hover",
      backend: "scip",
    });
    expect(hover.success).toBe(true);
    if (hover.success) {
      expect(
        (hover.data as { hover?: { contents: string } }).hover?.contents,
      ).toContain("incremented");
    }
  });
});
