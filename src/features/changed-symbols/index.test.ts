import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "vitest";

import { changedSymbolsSchema, execute } from "@features/changed-symbols";

function git(directory: string, args: string[]): void {
  execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
}

describe("get_changed_symbols", () => {
  test("applies bounded defaults", () => {
    const result = changedSymbolsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_files).toBe(300);
      expect(result.data.max_symbols).toBe(1000);
    }
  });

  test("rejects unsafe output limits", () => {
    expect(changedSymbolsSchema.safeParse({ max_files: 0 }).success).toBe(false);
    expect(changedSymbolsSchema.safeParse({ max_symbols: 5001 }).success).toBe(false);
  });

  test("maps tracked and untracked changes to current symbols", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-changed-symbols-"));
    const originalAllowedRoots = process.env.SRC_ALLOWED_ROOTS;
    try {
      fs.mkdirSync(path.join(directory, "src"));
      const examplePath = path.join(directory, "src", "example.ts");
      fs.writeFileSync(examplePath, "export function stable(): number { return 1; }\n");
      git(directory, ["init", "-q"]);
      git(directory, ["config", "user.email", "src-mcp-tests@example.test"]);
      git(directory, ["config", "user.name", "SRC MCP Tests"]);
      git(directory, ["add", "."]);
      git(directory, ["commit", "-qm", "initial"]);

      fs.writeFileSync(
        examplePath,
        "export function stable(): number { return 2; }\nexport function changed(): number { return 3; }\n",
      );
      fs.writeFileSync(
        path.join(directory, "src", "fresh.ts"),
        'export function fresh(): string { return "new"; }\n',
      );
      process.env.SRC_ALLOWED_ROOTS = directory;

      const result = await execute({ directory });

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      const data = result.data as {
        revision: string;
        files_changed: number;
        files: { file_path: string; status: string }[];
        symbols: { file_path: string; name: string }[];
      };
      expect(data.revision).not.toBe("");
      expect(data.files_changed).toBe(2);
      expect(data.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_path: "src/example.ts",
            status: "modified",
          }),
          expect.objectContaining({
            file_path: "src/fresh.ts",
            status: "added",
          }),
        ]),
      );
      expect(data.symbols).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_path: "src/example.ts",
            name: "stable",
          }),
          expect.objectContaining({ file_path: "src/fresh.ts", name: "fresh" }),
        ]),
      );
    } finally {
      if (originalAllowedRoots === undefined) {
        delete process.env.SRC_ALLOWED_ROOTS;
      } else {
        process.env.SRC_ALLOWED_ROOTS = originalAllowedRoots;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
