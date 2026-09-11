import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { createTaskManager } from "@core/tasks/manager";
import { createServer } from "@/server";

const protocolVersion = "2026-07-28";
const tasksExtension = "io.modelcontextprotocol/tasks";

describe("Tasks extension transport integration", () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("returns a task handle and retrieves it through tasks/get", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-http-"));
    directories.push(directory);
    vi.stubEnv("MCP_TASK_STORE_DIR", directory);
    vi.stubEnv("MCP_TASK_TOOLS", "get_server_info");

    const manager = createTaskManager();
    const handler = createMcpHandler(() => createServer(manager), {
      legacy: "reject",
      responseMode: "json",
    });
    const commonHeaders = {
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
    };
    const envelope = {
      "io.modelcontextprotocol/protocolVersion": protocolVersion,
      "io.modelcontextprotocol/clientCapabilities": {
        extensions: { [tasksExtension]: {} },
      },
    };

    try {
      const createResponse = await handler.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            ...commonHeaders,
            "mcp-method": "tools/call",
            "mcp-name": "get_server_info",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "get_server_info",
              arguments: {},
              _meta: envelope,
            },
          }),
        }),
      );
      expect(createResponse.status).toBe(200);
      const created = (await createResponse.json()) as {
        result?: { resultType?: string; taskId?: string; status?: string };
      };
      expect(created.result?.resultType).toBe("task");
      expect(created.result?.status).toBe("working");
      const taskId = created.result?.taskId;
      if (typeof taskId !== "string") {
        throw new Error("The task creation response did not contain a taskId");
      }

      const getResponse = await handler.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            ...commonHeaders,
            "mcp-method": "tasks/get",
            "mcp-name": taskId,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tasks/get",
            params: { taskId, _meta: envelope },
          }),
        }),
      );
      expect(getResponse.status).toBe(200);
      const retrieved = (await getResponse.json()) as {
        result?: { resultType?: string; taskId?: string; status?: string };
      };
      expect(retrieved.result?.resultType).toBe("complete");
      expect(retrieved.result?.taskId).toBe(taskId);
      expect(["working", "completed"]).toContain(retrieved.result?.status);
    } finally {
      await handler.close();
    }
  }, 20_000);

  test("rejects task operations when the per-request extension is absent", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-cap-"));
    directories.push(directory);
    vi.stubEnv("MCP_TASK_STORE_DIR", directory);

    const manager = createTaskManager();
    const handler = createMcpHandler(() => createServer(manager), {
      legacy: "reject",
      responseMode: "json",
    });

    try {
      const response = await handler.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "mcp-protocol-version": protocolVersion,
            "mcp-method": "tasks/get",
            "mcp-name": "missing-task",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tasks/get",
            params: {
              taskId: "missing-task",
              _meta: {
                "io.modelcontextprotocol/protocolVersion": protocolVersion,
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error?: { code?: number; data?: { requiredCapabilities?: unknown } };
      };
      expect(body.error?.code).toBe(-32021);
      expect(body.error?.data?.requiredCapabilities).toBeDefined();
    } finally {
      await handler.close();
    }
  }, 20_000);

  test("supports task lifecycle methods and rejects malformed task requests", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-life-http-"));
    directories.push(directory);
    vi.stubEnv("MCP_TASK_STORE_DIR", directory);
    vi.stubEnv("MCP_TASK_TOOLS", "get_server_info");

    const manager = createTaskManager();
    const handler = createMcpHandler(() => createServer(manager), {
      legacy: "reject",
      responseMode: "json",
    });
    const commonHeaders = {
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
    };
    const envelope = {
      "io.modelcontextprotocol/protocolVersion": protocolVersion,
      "io.modelcontextprotocol/clientCapabilities": {
        extensions: { [tasksExtension]: {} },
      },
    };
    const sendRequest = async (
      id: number,
      method: string,
      params: Record<string, unknown>,
      extraHeaders: Record<string, string>,
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      const response = await handler.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: { ...commonHeaders, ...extraHeaders },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params: { ...params, _meta: envelope },
          }),
        }),
      );
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };

    try {
      const created = await sendRequest(
        1,
        "tools/call",
        { name: "get_server_info", arguments: {} },
        { "mcp-method": "tools/call", "mcp-name": "get_server_info" },
      );
      const taskId = (created.body.result as Record<string, unknown> | undefined)?.taskId as string;
      expect(created.status).toBe(200);
      expect(typeof taskId).toBe("string");

      const encodedTaskId = `=?base64?${Buffer.from(taskId, "utf8").toString("base64")}?=`;
      const retrieved = await sendRequest(
        2,
        "tasks/get",
        { taskId },
        { "mcp-method": "tasks/get", "mcp-name": encodedTaskId },
      );
      expect(retrieved.body.result).toMatchObject({ resultType: "complete" });

      const updated = await sendRequest(
        3,
        "tasks/update",
        { taskId, inputResponses: {} },
        { "mcp-method": "tasks/update", "mcp-name": taskId },
      );
      expect(updated.body.result).toMatchObject({ resultType: "complete" });

      const cancelled = await sendRequest(
        4,
        "tasks/cancel",
        { taskId },
        { "mcp-method": "tasks/cancel", "mcp-name": taskId },
      );
      expect(cancelled.body.result).toMatchObject({ resultType: "complete" });

      const missingHeader = await sendRequest(
        5,
        "tasks/get",
        { taskId },
        { "mcp-method": "tasks/get" },
      );
      expect(missingHeader.body.error).toMatchObject({ code: -32020 });

      const invalidUpdate = await sendRequest(
        6,
        "tasks/update",
        { taskId, inputResponses: "invalid" },
        { "mcp-method": "tasks/update", "mcp-name": taskId },
      );
      expect(invalidUpdate.body.error).toMatchObject({ code: -32602 });

      const missingId = await sendRequest(
        7,
        "tasks/get",
        {},
        { "mcp-method": "tasks/get", "mcp-name": "missing" },
      );
      expect(missingId.body.error).toMatchObject({ code: -32602 });

      const unknown = await sendRequest(
        8,
        "tasks/get",
        { taskId: "unknown-task" },
        { "mcp-method": "tasks/get", "mcp-name": "unknown-task" },
      );
      expect(unknown.body.error).toMatchObject({ code: -32602 });
    } finally {
      manager.close();
      await handler.close();
    }
  }, 20_000);

  test("returns invalid-argument errors for task-enabled tools", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-invalid-http-"));
    directories.push(directory);
    vi.stubEnv("MCP_TASK_STORE_DIR", directory);
    vi.stubEnv("MCP_TASK_TOOLS", "parse_ast");

    const manager = createTaskManager();
    const handler = createMcpHandler(() => createServer(manager), {
      legacy: "reject",
      responseMode: "json",
    });
    try {
      const response = await handler.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "mcp-protocol-version": protocolVersion,
            "mcp-method": "tools/call",
            "mcp-name": "parse_ast",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "parse_ast",
              arguments: {},
              _meta: {
                "io.modelcontextprotocol/protocolVersion": protocolVersion,
                "io.modelcontextprotocol/clientCapabilities": {
                  extensions: { [tasksExtension]: {} },
                },
              },
            },
          }),
        }),
      );
      const body = (await response.json()) as {
        error?: { code?: number };
      };
      expect(response.status).toBe(200);
      expect(body.error?.code).toBe(-32602);
    } finally {
      manager.close();
      await handler.close();
    }
  }, 20_000);

  test("accepts flat union inputs when a tool is enabled for tasks", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-union-http-"));
    directories.push(directory);
    vi.stubEnv("MCP_TASK_STORE_DIR", directory);
    vi.stubEnv("MCP_TASK_TOOLS", "run_static_analysis");
    vi.stubEnv("SRC_STATIC_ANALYSIS_ENABLED", "false");
    const manager = createTaskManager();
    const handler = createMcpHandler(() => createServer(manager), {
      legacy: "reject",
      responseMode: "json",
    });
    try {
      const response = await handler.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "mcp-protocol-version": protocolVersion,
            "mcp-method": "tools/call",
            "mcp-name": "run_static_analysis",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "run_static_analysis",
              arguments: {
                backend: "ast-grep",
                pattern: "console.log($A)",
                language: "typescript",
              },
              _meta: {
                "io.modelcontextprotocol/protocolVersion": protocolVersion,
                "io.modelcontextprotocol/clientCapabilities": {
                  extensions: { [tasksExtension]: {} },
                },
              },
            },
          }),
        }),
      );
      const body = (await response.json()) as {
        result?: { taskId?: string; resultType?: string };
      };
      expect(body.result?.resultType).toBe("task");
      const taskId = body.result?.taskId;
      expect(taskId).toBeTypeOf("string");
      if (taskId === undefined) {
        throw new Error("No task handle");
      }
      await vi.waitFor(() => {
        expect(manager.getTask(taskId)).toMatchObject({
          status: "completed",
          result: {
            structuredContent: {
              success: true,
              schema_version: 1,
              message: "Static analysis is disabled",
            },
          },
        });
      });
    } finally {
      manager.close();
      await handler.close();
    }
  }, 20_000);
});
