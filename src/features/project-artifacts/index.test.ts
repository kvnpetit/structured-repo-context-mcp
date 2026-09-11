import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { execute, projectArtifactsSchema } from "@features/project-artifacts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("get_project_artifacts", () => {
  test("validates bounded defaults", () => {
    const result = projectArtifactsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.max_files).toBe(1_000);
      expect(result.data.include_content).toBe(false);
      expect(result.data.redact_secrets).toBe(true);
    }
  });

  test("classifies, searches, and redacts project documentation", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-project-artifacts-"));
    temporaryDirectories.push(directory);
    fs.mkdirSync(path.join(directory, "docs"));
    fs.writeFileSync(
      path.join(directory, "README.md"),
      "# Project overview\n\nSee [architecture](docs/architecture.md).\n",
    );
    fs.writeFileSync(
      path.join(directory, "docs", "architecture.md"),
      ' # Architecture\n\napiKey: "secret-value"\n',
    );

    const result = execute({
      directory,
      query: "architecture",
      include_content: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    const data = result.data as {
      artifacts: {
        file_path: string;
        kind: string;
        content?: string;
        links: string[];
      }[];
      source_is_untrusted: boolean;
      secrets_redacted: boolean;
    };
    expect(data.source_is_untrusted).toBe(true);
    expect(data.secrets_redacted).toBe(true);
    expect(data.artifacts[0]).toMatchObject({
      file_path: "docs/architecture.md",
      kind: "architecture",
    });
    expect(data.artifacts[0]?.content).not.toContain("secret-value");
    expect(data.artifacts.some((artifact) => artifact.links.includes("docs/architecture.md"))).toBe(
      true,
    );
  });
});
