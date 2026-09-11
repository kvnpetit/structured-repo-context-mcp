import { describe, expect, test } from "vitest";
import { request as httpRequest } from "node:http";
import { hasValidBearerToken, isLoopbackHost, isWildcardHost, startHttpServer } from "@/http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

describe("HTTP transport", () => {
  async function postChunked(url: string, chunks: string[]): Promise<number> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const request = httpRequest(
        {
          hostname: parsed.hostname,
          port: Number(parsed.port),
          path: parsed.pathname,
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (response) => {
          response.resume();
          response.once("end", () => {
            resolve(response.statusCode ?? 0);
          });
        },
      );
      request.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNRESET") {
          resolve(413);
          return;
        }
        reject(error);
      });
      for (const chunk of chunks) {
        request.write(chunk);
      }
      request.end();
    });
  }

  test("recognizes loopback and wildcard bind hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isWildcardHost("0.0.0.0")).toBe(true);
    expect(isWildcardHost("::")).toBe(true);
  });

  test("validates bearer tokens without accepting malformed headers", () => {
    const request = {
      headers: { authorization: "Bearer secret" },
    } as never;

    expect(hasValidBearerToken(request, "secret")).toBe(true);
    expect(hasValidBearerToken(request, "other")).toBe(false);
    expect(
      hasValidBearerToken({ headers: { authorization: "Basic secret" } } as never, "secret"),
    ).toBe(false);
    expect(hasValidBearerToken(request, undefined)).toBe(true);
  });

  test("refuses an unauthenticated non-loopback bind", async () => {
    await expect(startHttpServer({ host: "0.0.0.0", port: 0 })).rejects.toThrow(
      "MCP_HTTP_BEARER_TOKEN is required",
    );
  });

  test("requires explicit host validation for wildcard binds", async () => {
    const originalRoots = process.env.SRC_ALLOWED_ROOTS;
    process.env.SRC_ALLOWED_ROOTS = process.cwd();
    try {
      await expect(
        startHttpServer({
          host: "0.0.0.0",
          port: 0,
          bearerToken: "test-token",
        }),
      ).rejects.toThrow("MCP_HTTP_ALLOWED_HOSTS is required");
    } finally {
      if (originalRoots === undefined) {
        delete process.env.SRC_ALLOWED_ROOTS;
      } else {
        process.env.SRC_ALLOWED_ROOTS = originalRoots;
      }
    }
  });

  test("requires an explicit workspace allow-list for remote binds", async () => {
    const originalRoots = process.env.SRC_ALLOWED_ROOTS;
    delete process.env.SRC_ALLOWED_ROOTS;
    try {
      await expect(
        startHttpServer({
          host: "192.0.2.1",
          port: 0,
          bearerToken: "test-token",
          allowedHostnames: ["192.0.2.1"],
        }),
      ).rejects.toThrow("SRC_ALLOWED_ROOTS is required");
    } finally {
      if (originalRoots === undefined) {
        delete process.env.SRC_ALLOWED_ROOTS;
      } else {
        process.env.SRC_ALLOWED_ROOTS = originalRoots;
      }
    }
  });

  test("requires an explicit TLS proxy opt-in for remote binds", async () => {
    const originalRoots = process.env.SRC_ALLOWED_ROOTS;
    process.env.SRC_ALLOWED_ROOTS = process.cwd();
    try {
      await expect(
        startHttpServer({
          host: "0.0.0.0",
          port: 0,
          bearerToken: "test-token",
          allowedHostnames: ["localhost"],
        }),
      ).rejects.toThrow("requires TLS termination");
    } finally {
      if (originalRoots === undefined) {
        delete process.env.SRC_ALLOWED_ROOTS;
      } else {
        process.env.SRC_ALLOWED_ROOTS = originalRoots;
      }
    }
  });

  test("serves the MCP protocol over authenticated Streamable HTTP", async () => {
    const running = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      bearerToken: "test-token",
    });
    const unauthorized = await fetch(running.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2026-07-28",
          capabilities: {},
          clientInfo: { name: "http-test", version: "1.0.0" },
        },
      }),
    });
    expect(unauthorized.status).toBe(401);

    const transport = new StreamableHTTPClientTransport(new URL(running.url), {
      requestInit: {
        headers: { Authorization: "Bearer test-token" },
      },
    });
    const client = new Client(
      { name: "src-mcp-http-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );

    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe("modern");
      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === "get_code_snippet")).toBe(true);
    } finally {
      await client.close();
      await running.close();
    }
  }, 20_000);

  test("keeps the MCP endpoint explicit and enforces declared body limits", async () => {
    const running = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes: 16,
    });

    try {
      const notFound = await fetch(running.url.replace(/\/mcp$/u, "/"), {
        method: "POST",
        body: "{}",
      });
      expect(notFound.status).toBe(404);

      const oversized = await fetch(running.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ too: "01234567890123456789" }),
      });
      expect(oversized.status).toBe(413);
    } finally {
      await running.close();
    }
  });

  test("enforces body limits for chunked uploads without Content-Length", async () => {
    const running = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes: 16,
    });

    try {
      const status = await postChunked(running.url, ['{"payload":"', "01234567890123456789", '"}']);
      expect(status).toBe(413);
    } finally {
      await running.close();
    }
  });
});
