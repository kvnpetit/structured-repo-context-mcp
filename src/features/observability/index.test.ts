import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { metrics } from "@core/observability";
import {
  execute,
  observabilityFeature,
  observabilityOutputSchema,
  observabilitySchema,
} from "@features/observability";

describe("get_observability", () => {
  const directories: string[] = [];

  afterEach(() => {
    metrics.reset();
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("exposes bounded read-only JSON defaults", () => {
    expect(observabilityFeature.annotations?.readOnlyHint).toBe(true);
    expect(observabilitySchema.parse({})).toEqual({
      directory: ".",
      format: "json",
    });
  });

  test("returns structured local metrics without source or arguments", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-observability-"));
    directories.push(directory);
    metrics.recordTool("search_code", true, 12.5);

    const result = execute({ directory });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    const parsed = observabilityOutputSchema.safeParse({
      schema_version: 1,
      success: true,
      meta: {
        generated_at: new Date().toISOString(),
        local_only: true,
        bounded: true,
        provenance: "local-filesystem",
        index_freshness: "unknown",
      },
      data: result.data,
      message: result.message,
    });
    expect(parsed.success).toBe(true);
    expect(result.data).toMatchObject({
      directory,
      format: "json",
      source_is_untrusted: true,
      secrets_redacted: true,
      metrics: { tools: { search_code: { calls: 1, successes: 1 } } },
    });
    expect(JSON.stringify(result.data)).not.toContain("arguments");
  });

  test("renders a bounded Prometheus export", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-observability-prom-"));
    directories.push(directory);
    metrics.recordTool('tool"with\nlabel', false, 4);

    const result = execute({ directory, format: "prometheus" });

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { prometheus?: string };
      expect(data.prometheus).toContain("# TYPE src_mcp_tool_calls_total counter");
      expect(data.prometheus).toContain('tool="tool_with_label"');
      expect(result.message).toBe(data.prometheus);
    }
  });

  test("fails closed for an unavailable directory", () => {
    expect(execute({ directory: "./does-not-exist" })).toEqual({
      success: false,
      error: "Path not found",
    });
  });
});
