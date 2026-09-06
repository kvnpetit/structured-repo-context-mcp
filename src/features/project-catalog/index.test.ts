import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  executeGetProjectCatalog,
  executeRefreshProjectCatalog,
} from "@features/project-catalog";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-catalog-"));
  directories.push(directory);
  return directory;
}

describe("project artifact catalog", () => {
  test("refreshes metadata without persisting document bodies", async () => {
    const directory = makeDirectory();
    fs.mkdirSync(path.join(directory, "docs"));
    fs.writeFileSync(
      path.join(directory, "README.md"),
      "# Local project\n\nSee [architecture](docs/architecture.md).\n",
    );
    fs.writeFileSync(
      path.join(directory, "docs", "architecture.md"),
      "# Architecture\n\nSee [spec](implements:docs/spec.md).\n",
    );

    const refreshed = await executeRefreshProjectCatalog({ directory });
    expect(refreshed.success).toBe(true);
    if (!refreshed.success) {
      return;
    }
    const refreshData = refreshed.data as {
      artifacts_count: number;
      source_revision: string;
    };
    expect(refreshData.artifacts_count).toBe(2);
    expect(refreshData.source_revision).toMatch(/^[a-f0-9]{64}$/u);

    const statePath = path.join(
      directory,
      ".src-index",
      "artifacts-catalog.json",
    );
    const stateText = fs.readFileSync(statePath, "utf8");
    expect(stateText).not.toContain("# Architecture");

    const catalog = executeGetProjectCatalog({
      directory,
      query: "architecture",
      include_content: true,
    });
    expect(catalog.success).toBe(true);
    if (catalog.success) {
      const data = catalog.data as {
        artifacts: {
          file_path: string;
          links: { kind: string; target: string }[];
          content?: string;
        }[];
      };
      expect(data.artifacts[0]?.file_path).toBe("docs/architecture.md");
      expect(data.artifacts[0]?.links).toContainEqual({
        kind: "implements",
        target: "docs/spec.md",
      });
      expect(data.artifacts[0]?.content).toContain("Architecture");
    }
  });

  test("supports catalog pagination and reports missing state", async () => {
    const directory = makeDirectory();
    const missing = executeGetProjectCatalog({ directory });
    expect(missing.success).toBe(true);
    if (missing.success) {
      expect((missing.data as { state: string }).state).toBe("missing");
    }

    fs.writeFileSync(path.join(directory, "README.md"), "# One\n");
    fs.writeFileSync(path.join(directory, "notes.md"), "# Two\n");
    await executeRefreshProjectCatalog({ directory });
    const first = executeGetProjectCatalog({ directory, limit: 1 });
    expect(first.success).toBe(true);
    if (!first.success) {
      return;
    }
    const firstData = first.data as {
      next_cursor?: string;
      artifacts: unknown[];
    };
    expect(firstData.artifacts).toHaveLength(1);
    expect(firstData.next_cursor).toBeDefined();
    const second = executeGetProjectCatalog({
      directory,
      limit: 1,
      cursor: firstData.next_cursor,
    });
    expect(second.success).toBe(true);
    if (second.success) {
      expect((second.data as { artifacts: unknown[] }).artifacts).toHaveLength(
        1,
      );
    }
  });

  test("keeps custom catalog scopes in separate local state files", async () => {
    const directory = makeDirectory();
    fs.writeFileSync(path.join(directory, "README.md"), "# Scoped docs\n");

    const refreshed = await executeRefreshProjectCatalog({
      directory,
      scope: "release",
    });
    expect(refreshed.success).toBe(true);
    if (!refreshed.success) {
      return;
    }
    expect(refreshed.data).toMatchObject({
      scope: "release",
      catalog_file: ".src-index/artifacts-catalog-release.json",
    });
    expect(
      fs.existsSync(
        path.join(directory, ".src-index", "artifacts-catalog-release.json"),
      ),
    ).toBe(true);

    const defaultCatalog = executeGetProjectCatalog({ directory });
    expect(defaultCatalog.success).toBe(true);
    if (defaultCatalog.success) {
      expect(defaultCatalog.data).toMatchObject({
        scope: "project",
        state: "missing",
        artifacts: [],
      });
    }
    const releaseCatalog = executeGetProjectCatalog({
      directory,
      scope: "release",
      query: "scoped docs",
    });
    expect(releaseCatalog.success).toBe(true);
    if (releaseCatalog.success) {
      expect(releaseCatalog.data).toMatchObject({
        scope: "release",
        state: "ready",
        artifacts_total: 1,
      });
    }
  });
});
