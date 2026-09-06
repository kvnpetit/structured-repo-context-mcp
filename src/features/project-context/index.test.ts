import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  execute,
  projectContextFeature,
  projectContextSchema,
} from "@features/project-context";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("get_project_context", () => {
  test("validates bounded onboarding defaults", () => {
    const result = projectContextSchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_files).toBe(1_000);
      expect(result.data.max_manifests).toBe(100);
      expect(result.data.include_scripts).toBe(true);
      expect(result.data.redact_secrets).toBe(true);
    }
  });

  test("detects project identity, frameworks, scripts, workspaces and tests", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "src-mcp-context-"),
    );
    temporaryDirectories.push(directory);
    fs.mkdirSync(path.join(directory, "src"));
    fs.mkdirSync(path.join(directory, "packages", "api"), { recursive: true });
    fs.mkdirSync(path.join(directory, "tests"));
    fs.mkdirSync(path.join(directory, "docs"));
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "local-platform",
        packageManager: "pnpm@9.0.0",
        workspaces: ["packages/*"],
        main: "src/main.ts",
        dependencies: { react: "^19.0.0", express: "^5.0.0" },
        devDependencies: { vitest: "^3.0.0" },
        scripts: {
          dev: "vite --host",
          test: "vitest run",
          deploy: "TOKEN=sk-12345678901234567890 node scripts/deploy.js",
        },
      }),
    );
    fs.writeFileSync(
      path.join(directory, "pnpm-lock.yaml"),
      "lockfileVersion: 9\n",
    );
    fs.writeFileSync(
      path.join(directory, "src", "main.ts"),
      "export function main() { return 1; }\n",
    );
    fs.writeFileSync(
      path.join(directory, "tests", "main.test.ts"),
      "import { main } from '../src/main';\nmain();\n",
    );
    fs.writeFileSync(
      path.join(directory, "docs", "architecture.md"),
      "# Architecture\n",
    );
    fs.writeFileSync(
      path.join(directory, "tsconfig.json"),
      '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}',
    );

    const result = execute({ directory });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    const data = result.data as {
      project_name: string;
      project_kind: string;
      frameworks: { name: string }[];
      scripts: { name: string; command: string }[];
      workspaces: string[];
      entrypoints: string[];
      test_roots: string[];
      documentation_files: string[];
      path_aliases: Record<string, string>;
      secrets_redacted: boolean;
      profile_fingerprint: string;
    };
    expect(data.project_name).toBe("local-platform");
    expect(data.project_kind).toBe("workspace");
    expect(data.frameworks.map((framework) => framework.name)).toEqual(
      expect.arrayContaining(["React", "Express", "Vitest"]),
    );
    expect(data.scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "dev", command: "vite --host" }),
        expect.objectContaining({
          name: "deploy",
          command: "TOKEN=[REDACTED] node scripts/deploy.js",
        }),
      ]),
    );
    expect(data.workspaces).toContain("packages/*");
    expect(data.entrypoints).toContain("src/main.ts");
    expect(data.test_roots).toContain("tests");
    expect(data.documentation_files).toContain("docs/architecture.md");
    expect(data.path_aliases["@/"]).toBe("src/");
    expect(data.secrets_redacted).toBe(true);
    expect(data.profile_fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("reports bounded truncation and never executes scripts", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "src-mcp-context-limit-"),
    );
    temporaryDirectories.push(directory);
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      fs.writeFileSync(path.join(directory, name), "export const value = 1;\n");
    }
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "bounded",
        scripts: { test: 'node -e "process.exit(1)"' },
      }),
    );

    const result = execute({
      directory,
      max_files: 1,
      include_scripts: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    const data = result.data as {
      files_analyzed: number;
      truncated: boolean;
      scripts: unknown[];
    };
    expect(data.files_analyzed).toBe(1);
    expect(data.truncated).toBe(true);
    expect(data.scripts).toEqual([]);
  });

  test("declares read-only local behavior", () => {
    expect(projectContextFeature.annotations?.readOnlyHint).toBe(true);
    expect(projectContextFeature.description).toContain("never executes");
  });
});
