import type { ServerConfig } from "@types";

export const config: ServerConfig = {
  name: "src-mcp",
  fullName: "SRC (Structured Repo Context)",
  version: "1.0.0",
  description:
    "MCP server for codebase analysis with Treesitter (SCM queries), AST parsing, and embedding-based indexing",
};

const nodeEnv = process.env.NODE_ENV;
const logLevelEnv = process.env.LOG_LEVEL;

export const ENV = {
  isDev: nodeEnv === "development",
  isProd: nodeEnv === "production",
  logLevel: logLevelEnv ?? "info",
};
