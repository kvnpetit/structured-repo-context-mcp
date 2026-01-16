import type { ServerConfig } from "@/types";

export const config: ServerConfig = {
  name: "my-mcp-server",
  version: "1.0.0",
  description: "Serveur MCP personnalisé avec CLI",
};

/* eslint-disable @typescript-eslint/dot-notation */
const nodeEnv = process.env["NODE_ENV"];
const logLevelEnv = process.env["LOG_LEVEL"];
/* eslint-enable @typescript-eslint/dot-notation */

export const ENV = {
  isDev: nodeEnv === "development",
  isProd: nodeEnv === "production",
  logLevel: logLevelEnv ?? "info",
};
