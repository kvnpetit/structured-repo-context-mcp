import type { CLICommand } from "@/types";
import { startServer } from "@/server";

export const serveCommand: CLICommand = {
  name: "serve",
  description: "Démarre le serveur MCP",
  options: [
    {
      flag: "--transport, -t",
      description: "Type de transport (stdio)",
      defaultValue: "stdio",
    },
  ],

  action(_args, _options): void {
    void startServer();
  },
};
