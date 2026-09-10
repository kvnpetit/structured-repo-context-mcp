import { describe, expect, test } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const serverEntry = path.join(projectRoot, "src", "index.ts");

describe("MCP stdio integration", () => {
  test("discovers the complete public surface and executes local tools", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, serverEntry],
      cwd: projectRoot,
      stderr: "pipe",
    });
    const client = new Client({ name: "src-mcp-test", version: "1.0.0" });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
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
      const destructiveTools = new Set([
        "index_codebase",
        "set_project_memory",
        "manage_index_snapshots",
      ]);
      for (const tool of tools.tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.outputSchema).toBeDefined();
        expect(tool.annotations?.readOnlyHint).toBeDefined();
        expect(tool.annotations?.destructiveHint).toBe(destructiveTools.has(tool.name));
      }

      const resources = await client.listResources();
      expect(resources.resources.slice(0, 2).map((resource) => resource.uri)).toEqual([
        "src://server/info",
        "src://server/capabilities",
      ]);
      expect(resources.resources.length).toBeGreaterThanOrEqual(2);
      expect(
        resources.resources
          .slice(2)
          .every((resource) =>
            /^src:\/\/project\/project-[a-f0-9]{24}\/(context|map|status|catalog|memory)$/u.test(
              resource.uri,
            ),
          ),
      ).toBe(true);
      const resourceTemplates = await client.listResourceTemplates();
      expect(resourceTemplates.resourceTemplates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "project_views",
            uriTemplate: "src://project/{project}/{view}",
          }),
        ]),
      );

      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name)).toEqual([
        "src-overview",
        "code-search-workflow",
        "search-tips",
        "project-onboarding",
        "architecture-review",
        "security-review",
        "refactor-impact",
      ]);

      const info = await client.callTool({
        name: "get_server_info",
        arguments: {},
      });
      expect(info.isError).not.toBe(true);
      expect(info.structuredContent).toMatchObject({
        schema_version: 1,
        success: true,
      });

      const ast = await client.callTool({
        name: "parse_ast",
        arguments: {
          content: "export function answer(): number { return 42; }",
          language: "typescript",
          max_depth: 2,
        },
      });
      expect(ast.isError).not.toBe(true);
      expect(ast.structuredContent).toMatchObject({
        schema_version: 1,
        success: true,
      });

      const context = await client.callTool({
        name: "get_project_context",
        arguments: { directory: projectRoot, max_files: 50 },
      });
      expect(context.isError).not.toBe(true);
      expect(context.structuredContent).toMatchObject({
        schema_version: 1,
        success: true,
      });
      const contextStructured = context.structuredContent as {
        data?: unknown;
      };
      const contextData = contextStructured.data as Record<string, unknown> | undefined;
      expect(contextData?.source_is_untrusted).toBe(true);
      expect(typeof contextData?.project_kind).toBe("string");
      expect(String(contextData?.profile_fingerprint)).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await client.close();
    }
  }, 60_000);

  test("serves the pinned modern 2026-07-28 stdio lifecycle", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, serverEntry],
      cwd: projectRoot,
      stderr: "pipe",
    });
    const client = new Client(
      { name: "src-mcp-modern-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );

    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe("modern");
      const discover = client.getDiscoverResult();
      expect(discover?.supportedVersions).toContain("2026-07-28");
      expect(discover?.capabilities).toMatchObject({
        tools: {},
        resources: {},
        prompts: {},
        extensions: { "io.modelcontextprotocol/tasks": {} },
      });
      const discovery = client.getServerVersion();
      expect(discovery?.name).toBe("src-mcp");
      const info = await client.callTool({
        name: "get_server_info",
        arguments: {},
      });
      expect(info.isError).not.toBe(true);
      expect(info.structuredContent).toMatchObject({
        schema_version: 1,
        success: true,
      });
    } finally {
      await client.close();
    }
  }, 60_000);
});
