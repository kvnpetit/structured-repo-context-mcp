import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { startHttpServer } from "../src/http.ts";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const serverEntry = path.join(projectRoot, "src", "index.ts");
const modernVersion = "2026-07-28";

const expectedTools = [
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
] as const;

interface ClientCase {
  name: string;
  expectedEra: "legacy" | "modern";
  createTransport: () => StdioClientTransport | StreamableHTTPClientTransport;
}

async function runCase(testCase: ClientCase): Promise<void> {
  const client = new Client(
    { name: `src-mcp-conformance-${testCase.name}`, version: "1.0.3" },
    testCase.expectedEra === "modern"
      ? { versionNegotiation: { mode: { pin: modernVersion } } }
      : undefined,
  );
  try {
    await client.connect(testCase.createTransport());
    assert.equal(client.getProtocolEra(), testCase.expectedEra);

    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      expectedTools,
      `${testCase.name}: tool order/surface changed`,
    );
    assert.equal(new Set(tools.tools.map((tool) => tool.name)).size, tools.tools.length);
    for (const tool of tools.tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.outputSchema, `${testCase.name}: ${tool.name} has no output schema`);
      assert.ok(tool.annotations, `${testCase.name}: ${tool.name} has no annotations`);
    }

    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === "src://server/info"));
    const templates = await client.listResourceTemplates();
    assert.ok(
      templates.resourceTemplates.some(
        (template) => template.uriTemplate === "src://project/{project}/{view}",
      ),
    );
    const prompts = await client.listPrompts();
    assert.equal(prompts.prompts.length, 7);

    if (testCase.expectedEra === "legacy") {
      const ping = await client.ping();
      assert.deepEqual(ping, {});
    } else {
      await assert.rejects(
        client.ping(),
        /not supported by the negotiated protocol version/iu,
        `${testCase.name}: modern protocol must reject legacy-only ping`,
      );
    }
    const info = await client.callTool({
      name: "get_server_info",
      arguments: {},
    });
    assert.notEqual(info.isError, true);
    assert.equal((info.structuredContent as { success?: boolean } | undefined)?.success, true);
    const observability = await client.callTool({
      name: "get_observability",
      arguments: { directory: projectRoot, format: "prometheus" },
    });
    assert.notEqual(observability.isError, true);
    const observabilityData = observability.structuredContent as
      | { data?: { prometheus?: string; secrets_redacted?: boolean } }
      | undefined;
    if (observabilityData?.data === undefined) {
      throw new Error(`${testCase.name}: observability data is missing`);
    }
    assert.equal(observabilityData.data.secrets_redacted, true);
    assert.match(observabilityData.data.prometheus ?? "", /src_mcp_/u);

    const staticResource = await client.readResource({
      uri: "src://server/info",
    });
    assert.equal(staticResource.contents.length, 1);
    assert.equal(staticResource.contents[0]?.mimeType, "application/json");
  } finally {
    await client.close();
  }
}

const running = await startHttpServer({ host: "127.0.0.1", port: 0 });
try {
  const cases: ClientCase[] = [
    {
      name: "stdio-legacy",
      expectedEra: "legacy",
      createTransport: () =>
        new StdioClientTransport({
          command: process.execPath,
          args: [tsxCli, serverEntry],
          cwd: projectRoot,
          stderr: "pipe",
        }),
    },
    {
      name: "stdio-modern",
      expectedEra: "modern",
      createTransport: () =>
        new StdioClientTransport({
          command: process.execPath,
          args: [tsxCli, serverEntry],
          cwd: projectRoot,
          stderr: "pipe",
        }),
    },
    {
      name: "http-legacy",
      expectedEra: "legacy",
      createTransport: () => new StreamableHTTPClientTransport(new URL(running.url)),
    },
    {
      name: "http-modern",
      expectedEra: "modern",
      createTransport: () => new StreamableHTTPClientTransport(new URL(running.url)),
    },
  ];

  for (const testCase of cases) {
    await runCase(testCase);
    console.log(`local conformance passed: ${testCase.name}`);
  }
  console.log(`local conformance passed: ${String(cases.length)} matrix cases`);
} finally {
  await running.close();
}
