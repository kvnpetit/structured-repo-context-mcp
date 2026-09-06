import { afterEach, describe, expect, test, vi } from "vitest";
import { createServer, startServer } from "@/server";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

vi.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: vi.fn().mockReturnValue({ close: vi.fn() }),
}));

describe("MCP Server", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("createServer returns a server instance", () => {
    const server = createServer();
    expect(server).toBeDefined();
  });

  test("server has registerTool method", () => {
    const server = createServer();
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    expect(typeof server.registerTool).toBe("function");
  });

  test("server has registerResource method", () => {
    const server = createServer();
    expect(typeof server.registerResource).toBe("function");
  });

  test("server has connect method", () => {
    const server = createServer();
    expect(typeof server.connect).toBe("function");
  });

  test("server has close method", () => {
    const server = createServer();
    expect(typeof server.close).toBe("function");
  });

  test("startServer serves the MCP server over modern stdio", async () => {
    await startServer();

    expect(serveStdio).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ legacy: "serve" }),
    );
    expect(McpServer).toBeDefined();
  });
});
