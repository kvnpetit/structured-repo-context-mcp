import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type McpServer,
  type MessageExtraInfo,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { executeFeature, formatFeatureResult } from "@tools/adapter";
import type { Feature } from "@features/types";

import type { TaskManager } from "@core/tasks/manager";
import { TASKS_EXTENSION_ID } from "@core/tasks/types";

const MODERN_REVISION = "2026-07-28";
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
const HEADER_MISMATCH = -32020;

interface LowLevelServer {
  _onrequest?: (request: JSONRPCRequest, extra?: MessageExtraInfo) => void;
  transport?: { send(message: JSONRPCMessage): Promise<void> };
  registerCapabilities(capabilities: Record<string, unknown>): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestMeta(
  request: JSONRPCRequest,
): Record<string, unknown> | undefined {
  const params = request.params;
  if (!isRecord(params) || !isRecord(params._meta)) {
    return undefined;
  }
  return params._meta;
}

function isModernRequest(request: JSONRPCRequest): boolean {
  const version = requestMeta(request)?.[PROTOCOL_VERSION_META_KEY];
  return (
    typeof version === "string" &&
    /^\d{4}-\d{2}-\d{2}$/u.test(version) &&
    version >= MODERN_REVISION
  );
}

function hasTaskCapability(request: JSONRPCRequest): boolean {
  const meta = requestMeta(request);
  const capabilities = meta?.[CLIENT_CAPABILITIES_META_KEY];
  const extensions = isRecord(capabilities)
    ? capabilities.extensions
    : undefined;
  return isRecord(extensions) && Object.hasOwn(extensions, TASKS_EXTENSION_ID);
}

function taskCapabilityData(): Record<string, unknown> {
  return {
    requiredCapabilities: {
      extensions: { [TASKS_EXTENSION_ID]: {} },
    },
  };
}

function decodeHeaderValue(value: string): string | undefined {
  const prefix = "=?base64?";
  const suffix = "?=";
  if (!(value.startsWith(prefix) && value.endsWith(suffix))) {
    return value;
  }
  const encoded = value.slice(prefix.length, -suffix.length);
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded,
    )
  ) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(encoded, "base64"),
    );
  } catch {
    return undefined;
  }
}

function headerError(
  request: JSONRPCRequest,
  message: string,
): {
  jsonrpc: "2.0";
  id: JSONRPCRequest["id"];
  error: Record<string, unknown>;
} {
  return {
    jsonrpc: "2.0",
    id: request.id,
    error: { code: HEADER_MISMATCH, message },
  };
}

function validateTaskHttpHeaders(
  method: string,
  taskId: string,
  extra?: MessageExtraInfo,
): string | undefined {
  const httpRequest = extra?.request;
  if (httpRequest === undefined) {
    return undefined;
  }
  const headerMethod = httpRequest.headers.get("mcp-method");
  if (headerMethod !== null && headerMethod !== method) {
    return `Mcp-Method does not match ${method}`;
  }
  const nameHeader = httpRequest.headers.get("mcp-name");
  if (nameHeader === null) {
    return "Mcp-Name is required for task methods";
  }
  const decoded = decodeHeaderValue(nameHeader.trim());
  if (decoded === undefined || decoded !== taskId) {
    return "Mcp-Name must identify the requested task";
  }
  return undefined;
}

function send(server: LowLevelServer, message: JSONRPCMessage): void {
  void server.transport?.send(message).catch(() => undefined);
}

function sendError(
  server: LowLevelServer,
  request: JSONRPCRequest,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): void {
  send(server, {
    jsonrpc: "2.0",
    id: request.id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  });
}

function featureInput(feature: Feature, args: unknown): unknown {
  if (feature.schema instanceof z.ZodObject) {
    return feature.schema.parse(args ?? {});
  }
  return feature.schema.parse(isRecord(args) ? args.input : undefined);
}

/**
 * Adds the current `io.modelcontextprotocol/tasks` extension to an McpServer.
 *
 * The TypeScript SDK v2 deliberately removed the old 2025 TaskStore runtime
 * and its modern registry does not contain these extension methods. The
 * narrowly-scoped dispatch shim below handles only the current extension and
 * delegates every other request to the SDK's public protocol funnel.
 */
export function installTaskExtension(
  server: McpServer,
  features: readonly Feature[],
  manager: TaskManager,
): void {
  if (!manager.enabled) {
    return;
  }

  const lowLevel = server.server as unknown as LowLevelServer;
  const original = lowLevel._onrequest;
  if (typeof original !== "function") {
    return;
  }

  lowLevel.registerCapabilities({
    extensions: { [TASKS_EXTENSION_ID]: {} },
  });
  const featureMap = new Map(
    features.map((feature) => [feature.name, feature]),
  );

  lowLevel._onrequest = function patchedOnRequest(request, extra): void {
    if (!isModernRequest(request)) {
      original.call(lowLevel, request, extra);
      return;
    }

    if (
      request.method === "tasks/get" ||
      request.method === "tasks/update" ||
      request.method === "tasks/cancel"
    ) {
      handleTaskMethod(lowLevel, manager, request, extra);
      return;
    }

    if (request.method === "tools/call" && hasTaskCapability(request)) {
      const params = isRecord(request.params) ? request.params : {};
      const name = typeof params.name === "string" ? params.name : undefined;
      const feature = name === undefined ? undefined : featureMap.get(name);
      if (feature !== undefined && manager.canCreateTask(feature.name)) {
        handleTaskToolCall(lowLevel, manager, feature, request);
        return;
      }
    }

    original.call(lowLevel, request, extra);
  };
}

function handleTaskMethod(
  server: LowLevelServer,
  manager: TaskManager,
  request: JSONRPCRequest,
  extra?: MessageExtraInfo,
): void {
  if (!hasTaskCapability(request)) {
    sendError(
      server,
      request,
      MISSING_REQUIRED_CLIENT_CAPABILITY,
      "The tasks extension is required for task operations",
      taskCapabilityData(),
    );
    return;
  }
  const params = isRecord(request.params) ? request.params : {};
  const taskId = typeof params.taskId === "string" ? params.taskId : undefined;
  if (taskId === undefined || taskId.length === 0) {
    sendError(server, request, INVALID_PARAMS, "taskId is required");
    return;
  }
  const headerProblem = validateTaskHttpHeaders(request.method, taskId, extra);
  if (headerProblem !== undefined) {
    send(server, headerError(request, headerProblem) as JSONRPCMessage);
    return;
  }

  if (request.method === "tasks/get") {
    const task = manager.getTask(taskId);
    if (task === undefined) {
      sendError(server, request, INVALID_PARAMS, "Task not found");
      return;
    }
    send(server, {
      jsonrpc: "2.0",
      id: request.id,
      result: { resultType: "complete", ...task },
    } as unknown as JSONRPCMessage);
    return;
  }

  if (request.method === "tasks/cancel") {
    if (!manager.cancelTask(taskId)) {
      sendError(server, request, INVALID_PARAMS, "Task not found");
      return;
    }
    send(server, {
      jsonrpc: "2.0",
      id: request.id,
      result: { resultType: "complete" },
    } as unknown as JSONRPCMessage);
    return;
  }

  const inputResponses = params.inputResponses;
  if (!isRecord(inputResponses)) {
    sendError(
      server,
      request,
      INVALID_PARAMS,
      "inputResponses must be an object",
    );
    return;
  }
  if (!manager.updateTask(taskId, inputResponses)) {
    sendError(server, request, INVALID_PARAMS, "Task not found");
    return;
  }
  send(server, {
    jsonrpc: "2.0",
    id: request.id,
    result: { resultType: "complete" },
  });
}

function handleTaskToolCall(
  server: LowLevelServer,
  manager: TaskManager,
  feature: Feature,
  request: JSONRPCRequest,
): void {
  const params = isRecord(request.params) ? request.params : {};
  try {
    const input = featureInput(feature, params.arguments);
    const task = manager.createTask(feature.name, async (context) => {
      const result = await executeFeature(feature, input, {
        signal: context.signal,
        reportProgress: context.reportProgress,
      });
      return formatFeatureResult(result);
    });
    send(server, {
      jsonrpc: "2.0",
      id: request.id,
      result: task,
    } as unknown as JSONRPCMessage);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Task execution is not available"
    ) {
      sendError(
        server,
        request,
        INTERNAL_ERROR,
        "Task execution is not available",
      );
      return;
    }
    sendError(server, request, INVALID_PARAMS, "Invalid tool arguments");
  }
}
