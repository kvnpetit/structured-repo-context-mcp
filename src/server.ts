import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { config } from "@config";
import { getEnabledFeatures, registerTools } from "@tools";
import { registerResources } from "@resources";
import { registerPrompts } from "@prompts";
import { logger } from "@utils";
import { createTaskManager, installTaskExtension } from "@core/tasks";

export function createServer(taskManager = createTaskManager()): McpServer {
  const server = new McpServer(
    {
      name: config.name,
      title: config.fullName,
      version: config.version,
      description: config.description,
      websiteUrl: config.homepage,
    },
    {
      instructions: config.instructions,
      cacheHints: {
        "tools/list": { ttlMs: 300_000, cacheScope: "public" },
        "prompts/list": { ttlMs: 300_000, cacheScope: "public" },
        "resources/list": { ttlMs: 300_000, cacheScope: "public" },
        "resources/templates/list": { ttlMs: 300_000, cacheScope: "public" },
        "server/discover": { ttlMs: 300_000, cacheScope: "public" },
      },
    },
  );

  const enabledFeatures = getEnabledFeatures();
  registerTools(server, enabledFeatures);
  registerResources(server);
  registerPrompts(server);
  installTaskExtension(server, enabledFeatures, taskManager);

  return server;
}

export async function startServer(): Promise<void> {
  serveStdio(() => createServer(), {
    legacy: "serve",
    onerror: (error) => {
      logger.error(`MCP transport error: ${error.message}`);
    },
  });
  logger.info(`${config.name} v${config.version} started`);
  await Promise.resolve();
}
