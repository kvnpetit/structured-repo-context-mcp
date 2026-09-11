import { describe, expect, test, vi } from "vitest";
import { getEnabledFeatures, getToolConfiguration, registerTools } from "@tools";
import { features } from "@features";

describe("Tool Registration", () => {
  function makeServer() {
    const calls: { name: string; config: Record<string, unknown> }[] = [];
    const mock = vi.fn((name: string, config: Record<string, unknown>, _handler: unknown) => {
      calls.push({ name, config });
    });
    return { server: { registerTool: mock } as never, mock, calls };
  }

  test("registers all features as tools", () => {
    const { server, mock } = makeServer();
    registerTools(server);
    expect(mock).toHaveBeenCalledTimes(features.length);
  });

  test("tool names match feature names", () => {
    const { server, calls } = makeServer();
    registerTools(server);

    for (const feature of features) {
      expect(calls.map((c) => c.name)).toContain(feature.name);
    }
  });

  test("tool descriptions are passed correctly", () => {
    const { server, calls } = makeServer();
    registerTools(server);

    for (const feature of features) {
      const call = calls.find((c) => c.name === feature.name);
      expect((call?.config as { description: string } | undefined)?.description).toBe(
        feature.description,
      );
    }
  });

  test("supports an explicit MCP tool allow-list", () => {
    const enabled = getEnabledFeatures("get_server_info,parse_ast,unknown");

    expect(enabled.map((feature) => feature.name)).toEqual(["get_server_info", "parse_ast"]);
  });

  test("keeps the complete surface for an empty or wildcard allow-list", () => {
    expect(getEnabledFeatures("")).toHaveLength(features.length);
    expect(getEnabledFeatures("*")).toHaveLength(features.length);
  });

  test("supports a read-only profile without hiding analysis tools", () => {
    const enabled = getEnabledFeatures(undefined, "readonly");

    expect(enabled.map((feature) => feature.name)).not.toContain("index_codebase");
    expect(enabled.map((feature) => feature.name)).not.toContain("update_index");
    expect(enabled.map((feature) => feature.name)).not.toContain("set_project_memory");
    expect(enabled.map((feature) => feature.name)).toContain("search_code");
  });

  test("supports a minimal profile and reports stale allow-list entries", () => {
    expect(getEnabledFeatures(undefined, "minimal").map((f) => f.name)).toEqual([
      "get_server_info",
      "search_code",
      "get_index_status",
      "get_diagnostics",
      "get_observability",
      "list_projects",
      "get_repository_map",
      "get_symbol_at_position",
      "assemble_task_context",
      "get_project_artifacts",
      "get_project_context",
      "semantic_navigation",
      "get_symbol_graph",
      "get_project_memory",
      "get_project_catalog",
      "get_git_context",
    ]);
    expect(getToolConfiguration("parse_ast,unknown")).toMatchObject({
      allowListConfigured: true,
      allowList: ["parse_ast", "unknown"],
      unknownAllowListEntries: ["unknown"],
      enabledTools: ["parse_ast"],
    });
  });
});
