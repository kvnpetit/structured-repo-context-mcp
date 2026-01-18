import { describe, expect, test } from "vitest";
import { createServer } from "@/server";

describe("MCP Server", () => {
  test("createServer returns a server instance", () => {
    const server = createServer();
    expect(server).toBeDefined();
  });

  test("server has tool method", () => {
    const server = createServer();
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    expect(typeof server.tool).toBe("function");
  });

  test("server has resource method", () => {
    const server = createServer();
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    expect(typeof server.resource).toBe("function");
  });

  test("server has connect method", () => {
    const server = createServer();
    expect(typeof server.connect).toBe("function");
  });

  test("server has close method", () => {
    const server = createServer();
    expect(typeof server.close).toBe("function");
  });
});
