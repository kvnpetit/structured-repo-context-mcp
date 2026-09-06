import { describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  execute,
  assembleTaskContextSchema,
} from "@features/assemble-task-context";
import { executeSetProjectMemory } from "@features/project-memory";
import { repositoryMapFeature } from "@features/repository-map";

describe("assemble_task_context", () => {
  test("requires a meaningful task and applies bounded defaults", () => {
    expect(assembleTaskContextSchema.safeParse({}).success).toBe(false);
    const result = assembleTaskContextSchema.safeParse({
      task: "understand authentication flow",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_tokens).toBe(4_000);
      expect(result.data.search_limit).toBe(8);
      expect(result.data.include_search).toBe(true);
      expect(result.data.depth).toBe("standard");
      expect(result.data.memory_min_confidence).toBe(0.4);
    }
  });

  test("assembles a useful map when the optional index is unavailable", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-context-"));
    try {
      fs.writeFileSync(
        path.join(directory, "auth.ts"),
        "export function authenticate(token: string) { return token.length > 0; }\n",
      );

      const result = await execute({
        directory,
        task: "understand authentication flow",
        include_search: true,
        max_tokens: 500,
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("repository map");
      const data = result.data as {
        focus_terms: string[];
        context: string;
        search: { available: boolean; error?: string };
        warnings: string[];
      };
      expect(data.focus_terms).toContain("authentication");
      expect(data.context).toContain("auth.ts");
      expect(data.context).toContain("untrusted source data");
      expect(data.search.available).toBe(false);
      expect(data.search.error).toContain("No index found");
      expect(data.warnings[0]).toContain("Semantic search unavailable");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("can assemble map-only context within the requested budget", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "src-context-map-"),
    );
    try {
      fs.writeFileSync(
        path.join(directory, "entry.ts"),
        "export function entry() { return true; }\n",
      );
      const result = await execute({
        directory,
        task: "inspect entry point",
        depth: "minimal",
        include_search: false,
        max_tokens: 150,
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        estimated_tokens: number;
        token_budget: number;
        search: { available: boolean };
        layers: {
          project: { enabled: boolean };
          memory: { enabled: boolean };
          artifacts: { enabled: boolean };
          git: { enabled: boolean };
          repository_map: { enabled: boolean };
        };
      };
      expect(data.search.available).toBe(false);
      expect(data.estimated_tokens).toBeLessThanOrEqual(data.token_budget + 1);
      expect(data.layers).toMatchObject({
        project: { enabled: false },
        memory: { enabled: false },
        artifacts: { enabled: false },
        git: { enabled: false },
        repository_map: { enabled: true },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("assembles project, memory, artifacts, Git, and map under a fair budget", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "src-context-rich-"),
    );
    try {
      fs.writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({
          name: "rich-context",
          scripts: { test: "vitest" },
          dependencies: { react: "1.0.0" },
        }),
      );
      fs.writeFileSync(
        path.join(directory, "README.md"),
        "# Authentication architecture\nUse the session boundary for authentication changes.\n",
      );
      fs.writeFileSync(
        path.join(directory, "auth.ts"),
        "export function authenticate(token: string) { return token.length > 0; }\n",
      );
      execFileSync("git", ["init"], { cwd: directory });
      execFileSync("git", ["config", "user.email", "tests@example.invalid"], {
        cwd: directory,
      });
      execFileSync("git", ["config", "user.name", "SRC tests"], {
        cwd: directory,
      });
      execFileSync("git", ["add", "."], { cwd: directory });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: directory });
      await executeSetProjectMemory({
        directory,
        operation: "upsert",
        id: "auth-boundary",
        kind: "decision",
        title: "Authentication boundary",
        body: "Keep token validation inside auth.ts",
        tags: ["authentication"],
        confidence: 0.9,
      });
      fs.appendFileSync(path.join(directory, "auth.ts"), "// pending change\n");

      const result = await execute({
        directory,
        task: "change authentication safely",
        depth: "standard",
        include_search: false,
        max_tokens: 1_000,
      });
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      const data = result.data as {
        estimated_tokens: number;
        token_budget: number;
        context: string;
        next_actions: string[];
        layers: Record<
          string,
          { enabled: boolean; available: boolean; allocated_tokens: number }
        >;
      };
      expect(data.estimated_tokens).toBeLessThanOrEqual(data.token_budget + 1);
      expect(data.context).toContain("## Project profile");
      expect(data.context).toContain("## Relevant project memory");
      expect(data.context).toContain("Authentication boundary");
      expect(data.context).toContain("## Relevant project artifacts");
      expect(data.context).toContain("README.md");
      expect(data.context).toContain("## Current Git state");
      expect(data.context).toContain("auth.ts");
      expect(data.context).toContain("## Repository map");
      for (const key of [
        "project",
        "memory",
        "artifacts",
        "git",
        "repository_map",
      ]) {
        expect(data.layers[key]).toMatchObject({
          enabled: true,
          available: true,
        });
        expect(data.layers[key]?.allocated_tokens).toBeGreaterThan(0);
      }
      expect(data.next_actions.join(" ")).toContain("get_git_context");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("redistributes unused layer budget and isolates rejected layers", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "src-context-budget-"),
    );
    try {
      for (let index = 0; index < 16; index += 1) {
        const functions = Array.from(
          { length: 8 },
          (_, symbol) =>
            `export function module${String(index)}AuthenticationBoundary${String(symbol)}(token: string) { return token.length + ${String(symbol)}; }`,
        ).join("\n");
        fs.writeFileSync(
          path.join(directory, `module-${String(index)}.ts`),
          `${functions}\n`,
        );
      }
      const budgeted = await execute({
        directory,
        task: "map every authentication boundary",
        include_search: false,
        max_tokens: 500,
      });
      expect(budgeted.success).toBe(true);
      if (budgeted.success) {
        const data = budgeted.data as {
          estimated_tokens: number;
          layers: Record<string, { truncated: boolean }>;
        };
        expect(data.estimated_tokens).toBeGreaterThan(450);
        expect(data.estimated_tokens).toBeLessThanOrEqual(501);
        expect(data.layers.repository_map?.truncated).toBe(true);
      }

      vi.spyOn(repositoryMapFeature, "execute").mockRejectedValueOnce(
        new Error("untrusted internal detail"),
      );
      const degraded = await execute({
        directory,
        task: "inspect authentication",
        depth: "minimal",
        include_search: false,
        max_tokens: 200,
      });
      expect(degraded.success).toBe(true);
      if (degraded.success) {
        expect(degraded.data).toMatchObject({
          layers: {
            repository_map: {
              enabled: true,
              available: false,
              error: "Repository map unavailable",
            },
          },
        });
        expect(JSON.stringify(degraded.data)).not.toContain(
          "untrusted internal detail",
        );
      }
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
