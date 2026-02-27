import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getServerInfo } from "@features";

export function registerResources(server: McpServer): void {
  server.registerResource(
    "server_info",
    "src://server/info",
    { mimeType: "application/json", description: "MCP server metadata" },
    (uri) => {
      const info = getServerInfo();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(info, null, 2),
          },
        ],
      };
    },
  );
}
