import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { execute, gitContextSchema } from "@features/git-context";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

function git(directory: string, args: string[]): void {
  execFileSync("git", ["-C", directory, ...args], {
    cwd: directory,
    stdio: "ignore",
    windowsHide: true,
  });
}

function gitOutput(directory: string, args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], {
    cwd: directory,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

describe("get_git_context", () => {
  test("validates bounded defaults", () => {
    const parsed = gitContextSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.include_status).toBe(true);
      expect(parsed.data.include_diff).toBe(true);
      expect(parsed.data.include_changed_symbols).toBe(true);
      expect(parsed.data.include_hotspots).toBe(false);
      expect(parsed.data.max_hotspots).toBe(25);
      expect(parsed.data.redact_secrets).toBe(true);
    }
  });

  test("returns local status, diff, history, blame, owners, and symbols", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-git-"));
    directories.push(directory);
    git(directory, ["init", "-q"]);
    git(directory, ["config", "user.email", "src-mcp-tests@example.test"]);
    git(directory, ["config", "user.name", "SRC MCP Tests"]);
    fs.mkdirSync(path.join(directory, ".github"));
    fs.writeFileSync(
      path.join(directory, "service.ts"),
      "export function service(): number {\n  return 1;\n}\n",
    );
    fs.writeFileSync(
      path.join(directory, ".github", "CODEOWNERS"),
      "*.ts @local-owner\n",
    );
    git(directory, ["add", "."]);
    git(directory, ["commit", "-qm", "initial service"]);
    fs.writeFileSync(
      path.join(directory, "service.ts"),
      "export function service(): number {\n  return 2;\n}\n",
    );
    fs.writeFileSync(
      path.join(directory, "new.ts"),
      "export function added() {}\n",
    );

    const result = await execute({
      directory,
      include_history: true,
      include_blame: true,
      include_codeowners: true,
      include_changed_symbols: true,
      max_diff_bytes: 20_000,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    const data = result.data as {
      git_available: boolean;
      head?: string;
      files: { path: string }[];
      diff: { text: string; truncated: boolean };
      history: { subject: string }[];
      blame: Record<string, unknown[]>;
      codeowners: { path?: string; lines: string[] };
      change_analysis: { symbols_detected: number };
      source_is_untrusted: boolean;
    };
    expect(data.git_available).toBe(true);
    expect(data.head).toMatch(/^[a-f0-9]{40}$/u);
    expect(data.files.map((file) => file.path)).toEqual([
      "new.ts",
      "service.ts",
    ]);
    expect(data.diff.text).toContain("service.ts");
    expect(data.diff.truncated).toBe(false);
    expect(data.history[0]?.subject).toBe("initial service");
    expect(data.blame["service.ts"]).toBeDefined();
    expect(data.codeowners).toMatchObject({ path: ".github/CODEOWNERS" });
    expect(data.codeowners.lines[0]).toContain("@local-owner");
    expect(data.change_analysis.symbols_detected).toBeGreaterThan(0);
    expect(data.source_is_untrusted).toBe(true);
  }, 30_000);

  test("rejects traversal and non-repositories without executing a user command", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-git-"));
    directories.push(directory);
    const traversal = await execute({
      directory,
      files: ["../outside"],
    });
    expect(traversal.success).toBe(false);
    expect(traversal.error).toContain("project-relative");

    const notRepository = await execute({ directory });
    expect(notRepository.success).toBe(false);
    expect(notRepository.error).toContain("Git context unavailable");
  });

  test("aggregates local historical hotspots and compares two local revisions", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-git-"));
    directories.push(directory);
    git(directory, ["init", "-q"]);
    git(directory, ["config", "user.email", "src-mcp-tests@example.test"]);
    git(directory, ["config", "user.name", "SRC MCP Tests"]);
    fs.writeFileSync(
      path.join(directory, "service.ts"),
      "export function service(): number {\n  return 1;\n}\n",
    );
    git(directory, ["add", "."]);
    git(directory, ["commit", "-qm", "initial service"]);
    const initial = gitOutput(directory, ["rev-parse", "HEAD"]);

    fs.writeFileSync(
      path.join(directory, "service.ts"),
      "export function service(): number {\n  return 2;\n}\n\nexport function helper() { return true; }\n",
    );
    fs.writeFileSync(
      path.join(directory, "README.md"),
      "Local revision comparison fixture\n",
    );
    git(directory, ["add", "."]);
    git(directory, ["commit", "-qm", "change service and docs"]);
    const latest = gitOutput(directory, ["rev-parse", "HEAD"]);

    const result = await execute({
      directory,
      include_status: false,
      include_diff: false,
      include_codeowners: false,
      include_changed_symbols: false,
      include_hotspots: true,
      compare_from: initial,
      compare_to: latest,
      max_history: 20,
      max_hotspots: 10,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    const data = result.data as {
      hotspots?: {
        commits_analyzed: number;
        files: { path: string; commits: number; churn: number }[];
        truncated: boolean;
      };
      revision_compare?: {
        from_commit: string;
        to_commit: string;
        files_changed: number;
        files: { path: string; status: string }[];
        truncated: boolean;
      };
    };
    expect(data.hotspots?.commits_analyzed).toBe(2);
    expect(data.hotspots?.files[0]).toMatchObject({
      path: "service.ts",
      commits: 2,
    });
    expect(data.hotspots?.files[0]?.churn).toBeGreaterThan(0);
    expect(data.hotspots?.truncated).toBe(false);
    expect(data.revision_compare).toMatchObject({
      from_commit: initial,
      to_commit: latest,
      files_changed: 2,
      truncated: false,
    });
    expect(data.revision_compare?.files).toEqual([
      { path: "README.md", status: "added" },
      { path: "service.ts", status: "modified" },
    ]);
  }, 30_000);

  test("rejects partial or range-based revision comparisons", () => {
    expect(gitContextSchema.safeParse({ compare_from: "HEAD~1" }).success).toBe(
      false,
    );
    expect(
      gitContextSchema.safeParse({
        compare_from: "HEAD~1..HEAD",
        compare_to: "HEAD",
      }).success,
    ).toBe(false);
  });
});
