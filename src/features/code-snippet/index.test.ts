import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execute } from "@features/code-snippet";

describe("get_code_snippet", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "code-snippet-test-"));
    fs.writeFileSync(
      path.join(directory, "unicode.ts"),
      "const café = 42;\nreturn café;\n",
    );
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("reads bounded UTF-8 offsets and reports positions", async () => {
    const source = fs.readFileSync(path.join(directory, "unicode.ts"), "utf8");
    const start = Buffer.byteLength("const ", "utf8");
    const result = await execute({
      directory,
      file_path: "unicode.ts",
      start_offset: start,
      end_offset: start + Buffer.byteLength("café", "utf8"),
      max_bytes: 100,
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      content: string;
      start_offset: number;
      end_offset: number;
      start: { line: number };
    };
    expect(data.content).toBe("café");
    expect(data.start_offset).toBe(start);
    expect(data.end_offset).toBe(start + Buffer.byteLength("café", "utf8"));
    expect(data.start.line).toBe(1);
    expect(source).toContain(data.content);
  });

  test("rejects reversed offsets", async () => {
    const result = await execute({
      directory,
      file_path: "unicode.ts",
      start_offset: 10,
      end_offset: 2,
      max_bytes: 100,
    });
    expect(result.success).toBe(false);
  });

  test("can redact inline secrets while preserving original offsets", async () => {
    fs.writeFileSync(
      path.join(directory, "secret.ts"),
      'const apiKey = "super-secret-value";\n',
    );
    const result = await execute({
      directory,
      file_path: "secret.ts",
      max_bytes: 200,
      redact_secrets: true,
    });

    expect(result.success).toBe(true);
    expect(
      (result.data as { content: string; source_redacted: boolean }).content,
    ).not.toContain("super-secret-value");
    expect((result.data as { source_redacted: boolean }).source_redacted).toBe(
      true,
    );
  });
});
