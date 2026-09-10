import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execute } from "@features/find-symbols";

describe("find_symbols", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "find-symbols-test-"));
    fs.writeFileSync(
      path.join(directory, "a.ts"),
      "export function greet(name: string) { return helper(name); }\nfunction helper(value: string) { return value; }\n",
    );
    fs.writeFileSync(
      path.join(directory, "b.ts"),
      'import { greet } from "./a";\nexport const result = greet("world");\n',
    );
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("finds definitions with byte offsets and bounded snippets", async () => {
    const result = await execute({
      directory,
      query: "greet",
      mode: "definitions",
      limit: 10,
      max_files: 10,
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      matches: {
        kind: string;
        file_path: string;
        start: { offset: number };
        snippet: string;
      }[];
    };
    expect(data.matches.some((match) => match.kind === "definition")).toBe(true);
    expect(data.matches[0]?.file_path).toBe("a.ts");
    expect(data.matches[0]?.start.offset).toBeGreaterThanOrEqual(0);
    expect(data.matches[0]?.snippet).toContain("greet");
  });

  test("finds references and imports without an embedding index", async () => {
    const references = await execute({
      directory,
      query: "greet",
      mode: "references",
      limit: 10,
      max_files: 10,
    });
    const imports = await execute({
      directory,
      query: "./a",
      mode: "imports",
      limit: 10,
      max_files: 10,
    });

    expect(references.success).toBe(true);
    expect((references.data as { matches: unknown[] }).matches.length).toBeGreaterThan(0);
    expect(imports.success).toBe(true);
    expect((imports.data as { matches: unknown[] }).matches.length).toBeGreaterThan(0);
  });

  test("redacts common secrets from navigation snippets by default", async () => {
    fs.writeFileSync(
      path.join(directory, "secret.ts"),
      'const apiKey = "secret-value";\napiKey;\n',
    );

    const result = await execute({
      directory,
      query: "apiKey",
      mode: "references",
      limit: 10,
      max_files: 10,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    const data = result.data as {
      secrets_redacted: boolean;
      matches: { snippet: string }[];
    };
    expect(data.secrets_redacted).toBe(true);
    expect(data.matches.some((match) => match.snippet.includes("secret-value"))).toBe(false);
  });

  test("rejects a file outside the project root", async () => {
    const result = await execute({
      directory,
      file_path: "../outside.ts",
      query: "x",
      mode: "definitions",
      limit: 10,
      max_files: 10,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("allowed workspace");
  });

  test("paginates deterministically and rejects a cursor for another query", async () => {
    fs.writeFileSync(
      path.join(directory, "pages.ts"),
      Array.from(
        { length: 5 },
        (_, index) => `export function page${String(index)}() { return ${String(index)}; }`,
      ).join("\n"),
    );

    const first = await execute({
      directory,
      query: "page",
      mode: "definitions",
      limit: 2,
      max_files: 10,
    });
    expect(first.success).toBe(true);
    if (!first.success) {
      return;
    }
    const firstData = first.data as {
      matches: { name: string }[];
      next_cursor?: string;
      cursor_offset: number;
      truncated: boolean;
    };
    expect(firstData.matches.map((match) => match.name)).toEqual(["page0", "page1"]);
    expect(firstData.cursor_offset).toBe(0);
    expect(firstData.truncated).toBe(true);
    expect(firstData.next_cursor).toBeDefined();

    const second = await execute({
      directory,
      query: "page",
      mode: "definitions",
      limit: 2,
      max_files: 10,
      cursor: firstData.next_cursor,
    });
    expect(second.success).toBe(true);
    if (!second.success) {
      return;
    }
    const secondData = second.data as {
      matches: { name: string }[];
      next_cursor?: string;
      cursor_offset: number;
    };
    expect(secondData.matches.map((match) => match.name)).toEqual(["page2", "page3"]);
    expect(secondData.cursor_offset).toBe(2);
    expect(secondData.next_cursor).toBeDefined();

    const mismatched = await execute({
      directory,
      query: "other",
      mode: "definitions",
      limit: 2,
      max_files: 10,
      cursor: firstData.next_cursor,
    });
    expect(mismatched.success).toBe(false);
    expect(mismatched.error).toContain("does not match this query");
  });
});
