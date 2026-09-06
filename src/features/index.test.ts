import { describe, expect, test } from "vitest";
import { features, getFeature, infoFeature } from "@features/index";

describe("Features Index", () => {
  test("features array contains infoFeature", () => {
    expect(features).toContain(infoFeature);
  });

  test("features array is not empty", () => {
    expect(features.map((feature) => feature.name)).toEqual([
      "get_server_info",
      "index_codebase",
      "search_code",
      "get_index_status",
      "update_index",
      "parse_ast",
      "query_code",
      "list_symbols",
      "analyze_file",
      "get_call_graph",
      "find_symbols",
      "get_dependency_graph",
      "get_code_snippet",
      "analyze_impact",
      "get_diagnostics",
      "get_observability",
      "list_projects",
      "get_repository_map",
      "get_symbol_at_position",
      "assemble_task_context",
      "find_dead_code",
      "get_changed_symbols",
      "get_project_artifacts",
      "get_project_context",
      "semantic_navigation",
      "get_symbol_graph",
      "get_project_memory",
      "set_project_memory",
      "get_project_catalog",
      "refresh_project_catalog",
      "get_git_context",
      "manage_index_snapshots",
      "run_static_analysis",
      "import_scip_index",
      "maintain_index",
    ]);
  });

  test("getFeature returns feature by name", () => {
    const feature = getFeature("get_server_info");

    expect(feature).toBeDefined();
    expect(feature?.name).toBe("get_server_info");
  });

  test("getFeature returns undefined for unknown feature", () => {
    const feature = getFeature("unknown_feature");

    expect(feature).toBeUndefined();
  });

  test("all features have required properties", () => {
    for (const feature of features) {
      expect(feature.name).toBeDefined();
      expect(feature.description).toBeDefined();
      expect(feature.schema).toBeDefined();
      expect(feature.execute).toBeDefined();
      expect(typeof feature.execute).toBe("function");
    }
  });
});
