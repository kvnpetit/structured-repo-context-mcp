import { timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  createMcpHandler,
  type McpHttpHandler,
  type PerRequestResponseMode,
} from "@modelcontextprotocol/server";
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createServer as createMcpServer } from "@/server";
import { config } from "@config";
import { logger } from "@utils";
import { createTaskManager } from "@core/tasks";
import { hasConfiguredAllowedRoots } from "@core/security";

const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 16;
const HARD_MAX_BODY_BYTES = 16 * 1024 * 1024;
const HARD_MAX_CONCURRENT_REQUESTS = 256;
const HTTP_HEADERS_TIMEOUT_MS = 15_000;
const HTTP_REQUEST_TIMEOUT_MS = 5 * 60_000;

export interface HttpServerOptions {
  host?: string;
  port?: number;
  bearerToken?: string;
  allowedHostnames?: string[];
  maxBodyBytes?: number;
  maxConcurrentRequests?: number;
  legacy?: "stateless" | "reject";
  responseMode?: PerRequestResponseMode;
}

export interface RunningHttpServer {
  server: Server;
  handler: McpHttpHandler;
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

interface ResolvedHttpOptions {
  host: string;
  port: number;
  bearerToken?: string;
  allowedHostnames: string[];
  maxBodyBytes: number;
  maxConcurrentRequests: number;
  legacy: "stateless" | "reject";
  responseMode: PerRequestResponseMode;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function parseAllowedHostnames(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/[;,]/u)
    .map((hostname) => hostname.trim())
    .filter((hostname) => hostname.length > 0);
}

function withFallback(value: string | undefined, fallback: string): string {
  return value === undefined || value.length === 0 ? fallback : value;
}

function optionalValue(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function isWildcardHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === "0.0.0.0" || normalized === "::";
}

export function getDefaultHttpOptions(): ResolvedHttpOptions {
  const configuredHost = process.env.MCP_HTTP_HOST?.trim();
  const host = withFallback(configuredHost, DEFAULT_HTTP_HOST);
  const configuredToken = optionalValue(process.env.MCP_HTTP_BEARER_TOKEN?.trim());
  const allowedHostnames = parseAllowedHostnames(process.env.MCP_HTTP_ALLOWED_HOSTS);
  const effectiveAllowedHostnames =
    allowedHostnames.length > 0 ? allowedHostnames : isWildcardHost(host) ? [] : [host];

  return {
    host,
    port: parsePositiveInteger(process.env.MCP_HTTP_PORT, DEFAULT_HTTP_PORT, 65_535),
    bearerToken: configuredToken,
    allowedHostnames: effectiveAllowedHostnames,
    maxBodyBytes: parsePositiveInteger(
      process.env.MCP_HTTP_MAX_BODY_BYTES,
      DEFAULT_MAX_BODY_BYTES,
      HARD_MAX_BODY_BYTES,
    ),
    maxConcurrentRequests: parsePositiveInteger(
      process.env.MCP_HTTP_MAX_CONCURRENT,
      DEFAULT_MAX_CONCURRENT_REQUESTS,
      HARD_MAX_CONCURRENT_REQUESTS,
    ),
    legacy: process.env.MCP_HTTP_LEGACY === "reject" ? "reject" : "stateless",
    responseMode:
      process.env.MCP_HTTP_RESPONSE_MODE === "sse" || process.env.MCP_HTTP_RESPONSE_MODE === "json"
        ? process.env.MCP_HTTP_RESPONSE_MODE
        : "auto",
  };
}

function resolveHttpOptions(options: HttpServerOptions): ResolvedHttpOptions {
  const defaults = getDefaultHttpOptions();
  const configuredHost = options.host?.trim();
  const host = withFallback(configuredHost, defaults.host);
  const allowedHostnames =
    options.allowedHostnames ??
    (options.host === undefined ? defaults.allowedHostnames : isWildcardHost(host) ? [] : [host]);
  const port = options.port ?? defaults.port;
  const maxBodyBytes = options.maxBodyBytes ?? defaults.maxBodyBytes;
  const maxConcurrentRequests = options.maxConcurrentRequests ?? defaults.maxConcurrentRequests;
  const configuredToken = options.bearerToken?.trim();
  const bearerToken = configuredToken ?? defaults.bearerToken;

  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("MCP HTTP port must be an integer between 0 and 65535");
  }
  if (
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes <= 0 ||
    maxBodyBytes > HARD_MAX_BODY_BYTES
  ) {
    throw new Error(
      `MCP HTTP body limit must be between 1 and ${String(HARD_MAX_BODY_BYTES)} bytes`,
    );
  }
  if (
    !Number.isSafeInteger(maxConcurrentRequests) ||
    maxConcurrentRequests <= 0 ||
    maxConcurrentRequests > HARD_MAX_CONCURRENT_REQUESTS
  ) {
    throw new Error(
      `MCP HTTP concurrency limit must be between 1 and ${String(HARD_MAX_CONCURRENT_REQUESTS)}`,
    );
  }
  if (!isLoopbackHost(host) && !bearerToken) {
    throw new Error("MCP_HTTP_BEARER_TOKEN is required when MCP HTTP binds to a non-loopback host");
  }
  if (!isLoopbackHost(host) && !hasConfiguredAllowedRoots()) {
    throw new Error("SRC_ALLOWED_ROOTS is required when MCP HTTP binds to a non-loopback host");
  }
  if (!isLoopbackHost(host) && isWildcardHost(host) && allowedHostnames.length === 0) {
    throw new Error("MCP_HTTP_ALLOWED_HOSTS is required when MCP HTTP binds to a wildcard host");
  }

  return {
    host,
    port,
    bearerToken,
    allowedHostnames,
    maxBodyBytes,
    maxConcurrentRequests,
    legacy: options.legacy ?? defaults.legacy,
    responseMode: options.responseMode ?? defaults.responseMode,
  };
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

export function hasValidBearerToken(
  req: IncomingMessage,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) {
    return true;
  }

  const authorization = getHeader(req, "authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }

  const supplied = Buffer.from(authorization.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    return;
  }

  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
    ...headers,
  });
  res.end(payload);
}

function hasAcceptableBodySize(
  req: IncomingMessage,
  maxBodyBytes: number,
  res: ServerResponse,
): boolean {
  const contentLength = getHeader(req, "content-length");
  if (contentLength === undefined) {
    return true;
  }

  const parsed = Number(contentLength);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    sendJson(res, 400, { error: "Invalid Content-Length" });
    return false;
  }
  if (parsed > maxBodyBytes) {
    sendJson(res, 413, { error: "Request body too large" });
    return false;
  }
  return true;
}

function getRequestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

/**
 * Enforce the body cap for chunked requests as well as requests carrying a
 * Content-Length header. The MCP handler consumes the request stream itself,
 * so this listener observes bytes without buffering or executing the body.
 */
function monitorRequestBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBodyBytes: number,
): () => void {
  let bodyBytes = 0;
  let rejected = false;
  const onData = (chunk: Buffer | string): void => {
    if (rejected) {
      return;
    }
    bodyBytes += Buffer.byteLength(chunk);
    if (bodyBytes <= maxBodyBytes) {
      return;
    }

    rejected = true;
    sendJson(res, 413, { error: "Request body too large" });
    // Give Node a chance to flush the 413 before closing an oversized upload.
    setImmediate(() => {
      if (!req.destroyed) {
        req.destroy();
      }
    });
  };

  req.on("data", onData);
  return () => {
    req.off("data", onData);
  };
}

async function closeNodeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startHttpServer(options: HttpServerOptions = {}): Promise<RunningHttpServer> {
  const resolved = resolveHttpOptions(options);
  const taskManager = createTaskManager();
  const handler = createMcpHandler(() => createMcpServer(taskManager), {
    legacy: resolved.legacy,
    responseMode: resolved.responseMode,
    onerror: () => {
      logger.error("MCP HTTP handler error");
    },
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror: () => {
      logger.error("MCP HTTP transport error");
    },
  });
  const validateHost = isLoopbackHost(resolved.host)
    ? localhostHostValidation()
    : hostHeaderValidation(resolved.allowedHostnames);
  const validateOrigin = isLoopbackHost(resolved.host)
    ? localhostOriginValidation()
    : originValidation(resolved.allowedHostnames);

  let activeRequests = 0;
  const server = createHttpServer(
    {
      headersTimeout: HTTP_HEADERS_TIMEOUT_MS,
      requestTimeout: HTTP_REQUEST_TIMEOUT_MS,
    },
    (req, res) => {
      if (getRequestPath(req) !== "/mcp") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      if (!validateHost(req, res) || !validateOrigin(req, res)) {
        return;
      }
      if (!hasValidBearerToken(req, resolved.bearerToken)) {
        sendJson(res, 401, { error: "Unauthorized" }, { "www-authenticate": "Bearer" });
        return;
      }
      if (!hasAcceptableBodySize(req, resolved.maxBodyBytes, res)) {
        return;
      }
      if (activeRequests >= resolved.maxConcurrentRequests) {
        sendJson(res, 429, { error: "Too many concurrent requests" }, { "retry-after": "1" });
        return;
      }

      activeRequests += 1;
      const stopBodyMonitor = monitorRequestBody(req, res, resolved.maxBodyBytes);
      void nodeHandler(req, res)
        .catch(() => {
          sendJson(res, 500, { error: "MCP request failed" });
        })
        .finally(() => {
          stopBodyMonitor();
          activeRequests -= 1;
        });
    },
  );

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(resolved.port, resolved.host);
    });
  } catch (error) {
    await handler.close().catch(() => undefined);
    throw error;
  }

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : resolved.port;
  const displayHost =
    resolved.host.includes(":") && !resolved.host.startsWith("[")
      ? `[${resolved.host}]`
      : resolved.host;
  const url = `http://${displayHost}:${String(port)}/mcp`;
  logger.info(`${config.name} HTTP transport listening on ${url}`);

  let closed = false;
  return {
    server,
    handler,
    host: resolved.host,
    port,
    url,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      taskManager.close();
      try {
        await handler.close();
      } finally {
        await closeNodeServer(server);
      }
    },
  };
}
