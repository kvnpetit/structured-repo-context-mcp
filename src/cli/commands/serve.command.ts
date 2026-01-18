import { defineCommand } from "citty";
import { startServer } from "@/server";

export const serveCommand = defineCommand({
  meta: {
    name: "serve",
    description: "Start the MCP server",
  },
  args: {
    transport: {
      type: "string",
      alias: "t",
      description: "Transport type (stdio)",
      default: "stdio",
    },
  },
  async run() {
    await startServer();
  },
});
