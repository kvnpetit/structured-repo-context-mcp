import { defineCommand } from "citty";
import { startHttpServer } from "@/http";
import { startServer } from "@/server";
import { createIndexWatcher } from "@core/embeddings";
import { EMBEDDING_CONFIG } from "@config";
import { logger } from "@utils";

export const serveCommand = defineCommand({
  meta: {
    name: "serve",
    description: "Start the MCP server",
  },
  args: {
    transport: {
      type: "string",
      alias: "t",
      description: "Transport type (stdio or http)",
      default: "stdio",
    },
    host: {
      type: "string",
      description: "HTTP bind host (only used with --transport http)",
      default: process.env.MCP_HTTP_HOST ?? "127.0.0.1",
    },
    port: {
      type: "string",
      description: "HTTP bind port (only used with --transport http)",
      default: process.env.MCP_HTTP_PORT ?? "3000",
    },
    directory: {
      type: "string",
      alias: "d",
      description: "Directory to watch and index (defaults to current directory)",
      default: ".",
    },
    watch: {
      type: "boolean",
      alias: "w",
      description: "Enable file watcher for automatic indexing",
      default: true,
    },
  },
  async run({ args }) {
    const { directory, watch } = args;
    const transport = args.transport.toLowerCase();
    if (transport !== "stdio" && transport !== "http") {
      throw new Error(`Unsupported transport: ${transport}`);
    }

    let runningHttpServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let watcher: ReturnType<typeof createIndexWatcher> | undefined;

    // Start watcher if enabled
    if (watch) {
      watcher = createIndexWatcher({
        directory,
        config: EMBEDDING_CONFIG,
        onError: (error) => {
          logger.error(`Watcher error: ${error.message}`);
        },
      });

      try {
        await watcher.start();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Watcher disabled: ${msg}`);
      }
    }

    const cleanup = async (): Promise<void> => {
      await watcher?.stop();
      await runningHttpServer?.close();
    };
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      void cleanup().finally(() => {
        process.exit(0);
      });
    };
    if (watch || transport === "http") {
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    }

    try {
      if (transport === "http") {
        const configuredHostnames = process.env.MCP_HTTP_ALLOWED_HOSTS?.split(/[;,]/u)
          .map((hostname) => hostname.trim())
          .filter((hostname) => hostname.length > 0);
        runningHttpServer = await startHttpServer({
          host: args.host,
          port: Number(args.port),
          ...(configuredHostnames === undefined ? {} : { allowedHostnames: configuredHostnames }),
        });
        return;
      }

      await startServer();
    } catch (error) {
      await cleanup();
      throw error;
    }
  },
});
