import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { execute, staticAnalysisSchema } from "@features/static-analysis";

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("run_static_analysis", () => {
  test("accepts bounded pattern and CodeQL inputs", () => {
    expect(
      staticAnalysisSchema.safeParse({
        backend: "semgrep",
        pattern: "$X == $X",
        language: "typescript",
      }).success,
    ).toBe(true);
    expect(
      staticAnalysisSchema.safeParse({
        backend: "codeql",
        database: "build/db",
        query_file: "queries/security.ql",
      }).success,
    ).toBe(true);
    expect(
      staticAnalysisSchema.safeParse({
        backend: "semgrep",
        rule_file: "rules/security.yml",
      }).success,
    ).toBe(true);
    expect(
      staticAnalysisSchema.safeParse({
        backend: "ast-grep",
        rule_file: "rules/no-danger.yml",
      }).success,
    ).toBe(true);
  });

  test("is disabled by default and does not probe an executable", async () => {
    vi.stubEnv("SRC_STATIC_ANALYSIS_ENABLED", "false");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-static-"));
    directories.push(directory);
    const result = await execute({
      directory,
      backend: "semgrep",
      pattern: "$X == $X",
      language: "typescript",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        enabled: false,
        available: false,
        findings: [],
        source_is_untrusted: true,
      });
    }
  });

  test("rejects unsafe paths before any analyzer invocation", async () => {
    vi.stubEnv("SRC_STATIC_ANALYSIS_ENABLED", "true");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-static-"));
    directories.push(directory);
    const result = await execute({
      directory,
      backend: "ast-grep",
      pattern: "$X",
      language: "typescript",
      paths: ["../outside"],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("project-relative");
  });

  test("keeps local versioned rule files disabled without probing tools", async () => {
    vi.stubEnv("SRC_STATIC_ANALYSIS_ENABLED", "false");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-static-"));
    directories.push(directory);
    const result = await execute({
      directory,
      backend: "semgrep",
      rule_file: "rules/security.yml",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        query_kind: "rules-file",
        rule_file: "rules/security.yml",
        enabled: false,
        available: false,
      });
    }
  });
});
