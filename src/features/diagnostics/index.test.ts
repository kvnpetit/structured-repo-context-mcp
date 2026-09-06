import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { EMBEDDING_CONFIG } from "@config";
import { diagnosticsFeature, execute } from "@features/diagnostics";

describe("Diagnostics feature", () => {
  const directories: string[] = [];
  const originalProvider = EMBEDDING_CONFIG.embeddingProvider;

  afterEach(() => {
    EMBEDDING_CONFIG.embeddingProvider = originalProvider;
    vi.unstubAllEnvs();
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("exposes a read-only bounded diagnostic tool", () => {
    expect(diagnosticsFeature.name).toBe("get_diagnostics");
    expect(diagnosticsFeature.annotations?.readOnlyHint).toBe(true);
    expect(diagnosticsFeature.schema.safeParse({}).success).toBe(true);
  });

  test("rejects a missing project without contacting a provider", async () => {
    const result = await execute({ directory: "./does-not-exist" });
    expect(result).toEqual({ success: false, error: "Path not found" });
  });

  test("reports provider, security, task and metric configuration", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "src-mcp-diagnostics-"),
    );
    directories.push(directory);
    EMBEDDING_CONFIG.embeddingProvider = "lexical";
    vi.stubEnv(
      "SRC_ALLOWED_ROOTS",
      `${directory};${path.join(directory, "missing-root")}`,
    );
    vi.stubEnv("MCP_TASKS", "off");
    vi.stubEnv("MCP_TASK_TTL_MS", "none");
    vi.stubEnv("MCP_TASK_TOOLS", "index_codebase,update_index");

    const result = await execute({ directory });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      directory,
      provider: { name: "lexical", healthy: true },
      security: {
        allowedRootsConfigured: true,
        configuredRootCount: 2,
        invalidConfiguredRoots: 1,
        sourceExecution: "disabled",
      },
      tasks: {
        enabled: false,
        ttlMs: null,
        configuredTools: ["index_codebase", "update_index"],
      },
    });
  });
});
