import { describe, expect, test, vi } from "vitest";
import { formatFeatureResult, registerFeatureAsTool } from "@tools/adapter";
import { z } from "zod";
import type { Feature } from "@features/types";
import type { ServerContext } from "@modelcontextprotocol/server";
import { createFeatureResultSchema } from "@features/utils";

const testSchema = z.object({
  param1: z.string().describe("First parameter"),
  param2: z.number().optional().describe("Second parameter"),
});

type TestInput = z.infer<typeof testSchema>;

describe("Tool Adapter", () => {
  const mockFeature: Feature<typeof testSchema> = {
    name: "test_tool",
    description: "A test tool",
    schema: testSchema,
    execute: (input: TestInput) => ({
      success: true,
      message: `Received: ${input.param1}`,
    }),
  };

  function makeServer() {
    const captured = {
      name: undefined as string | undefined,
      config: undefined as Record<string, unknown> | undefined,
      handler: undefined as
        | ((params: unknown, context?: ServerContext) => Promise<unknown>)
        | undefined,
    };
    const mock = vi.fn(
      (
        name: string,
        config: Record<string, unknown>,
        handler: (params: unknown, context?: ServerContext) => Promise<unknown>,
      ) => {
        captured.name = name;
        captured.config = config;
        captured.handler = handler;
      },
    );
    return { server: { registerTool: mock } as never, mock, captured };
  }

  test("registers feature with correct name", () => {
    const { server, mock, captured } = makeServer();
    registerFeatureAsTool(server, mockFeature);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(captured.name).toBe("test_tool");
  });

  test("registers feature with correct description", () => {
    const { server, captured } = makeServer();
    registerFeatureAsTool(server, mockFeature);
    expect((captured.config as { description: string }).description).toBe("A test tool");
  });

  test("passes a complete Zod schema to the modern MCP SDK", () => {
    const { server, captured } = makeServer();
    registerFeatureAsTool(server, mockFeature);
    const inputSchema = (captured.config as { inputSchema: z.ZodType }).inputSchema;
    expect(inputSchema).toBeDefined();
    expect(inputSchema).toBe(testSchema);
  });

  test("handler returns correct format for success", async () => {
    const { server, captured } = makeServer();
    registerFeatureAsTool(server, mockFeature);

    expect(captured.handler).toBeDefined();
    if (captured.handler === undefined) {
      throw new Error("Handler should be defined");
    }

    const result = (await captured.handler({ param1: "test" })) as {
      content: { type: string; text: string }[];
      isError: boolean;
    };

    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toBe("Received: test");
  });

  test("handler returns correct format for error", async () => {
    const errorFeature: Feature<typeof testSchema> = {
      ...mockFeature,
      execute: () => ({ success: false, error: "Something went wrong" }),
    };

    const { server, captured } = makeServer();
    registerFeatureAsTool(server, errorFeature);

    if (captured.handler === undefined) {
      throw new Error("Handler should be defined");
    }

    const result = (await captured.handler({ param1: "test" })) as {
      content: { type: string; text: string }[];
      isError: boolean;
    };

    expect(result.isError).toBe(true);
  });

  test("handler handles async feature execute", async () => {
    const asyncFeature: Feature<typeof testSchema> = {
      ...mockFeature,
      execute: async (input: TestInput) =>
        Promise.resolve({ success: true, message: `Async: ${input.param1}` }),
    };

    const { server, captured } = makeServer();
    registerFeatureAsTool(server, asyncFeature);

    if (captured.handler === undefined) {
      throw new Error("Handler should be defined");
    }

    const result = (await captured.handler({ param1: "test" })) as {
      content: { type: string; text: string }[];
      isError: boolean;
    };

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("Async: test");
  });

  test("forwards progress reporting and cancellation context", async () => {
    const reportFeature: Feature<typeof testSchema> = {
      ...mockFeature,
      execute: async (_input, context) => {
        expect(context?.signal?.aborted).toBe(false);
        await context?.reportProgress?.(1, 2, "halfway");
        return { success: true, message: "done" };
      },
    };
    const { server, captured } = makeServer();
    registerFeatureAsTool(server, reportFeature);

    if (captured.handler === undefined) {
      throw new Error("Handler should be defined");
    }
    const notify = vi.fn().mockResolvedValue(undefined);
    const abortController = new AbortController();
    await captured.handler({ param1: "test" }, {
      mcpReq: {
        signal: abortController.signal,
        _meta: { progressToken: "progress-1" },
        notify,
      },
    } as unknown as ServerContext);

    expect(notify).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: {
        progressToken: "progress-1",
        progress: 1,
        total: 2,
        message: "halfway",
      },
    });
  });

  test("normalizes unexpected feature failures without leaking details", async () => {
    const throwingFeature: Feature<typeof testSchema> = {
      ...mockFeature,
      execute: () => {
        throw new Error("C:\\private\\secret.ts: source text");
      },
    };

    const { server, captured } = makeServer();
    registerFeatureAsTool(server, throwingFeature);

    if (captured.handler === undefined) {
      throw new Error("Handler should be defined");
    }

    const result = (await captured.handler({ param1: "test" })) as {
      content: { type: string; text: string }[];
      isError: boolean;
      structuredContent: { success: boolean; error?: string };
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Tool execution failed");
    expect(result.structuredContent).toMatchObject({
      schema_version: 1,
      success: false,
      error: "Tool execution failed",
      meta: {
        local_only: true,
        bounded: true,
        provenance: "local-analysis",
      },
    });
  });

  test("handles non-ZodObject schema by wrapping in input key", () => {
    const simpleSchema = z.string();
    const simpleFeature: Feature<typeof simpleSchema> = {
      name: "simple_tool",
      description: "Simple tool",
      schema: simpleSchema,
      execute: () => ({ success: true, data: "ok" }),
    };

    const { server, captured } = makeServer();
    registerFeatureAsTool(server, simpleFeature);

    const inputSchema = (captured.config as { inputSchema: z.ZodType }).inputSchema;
    expect(inputSchema).toBeDefined();
    expect(inputSchema.safeParse({ input: "value" }).success).toBe(true);
  });

  test("flattens discriminated object unions for direct MCP arguments", async () => {
    const schema = z.discriminatedUnion("operation", [
      z.object({
        operation: z.literal("upsert"),
        id: z.string(),
        value: z.string(),
      }),
      z.object({ operation: z.literal("delete"), id: z.string() }),
    ]);
    const execute = vi.fn().mockReturnValue({ success: true, data: "ok" });
    const feature: Feature<typeof schema> = {
      name: "union_tool",
      description: "Union tool",
      schema,
      execute,
    };
    const { server, captured } = makeServer();
    registerFeatureAsTool(server, feature);
    const inputSchema = (captured.config as { inputSchema: z.ZodType }).inputSchema;

    expect(inputSchema).toBeInstanceOf(z.ZodObject);
    expect(inputSchema.safeParse({ operation: "upsert", id: "a", value: "x" }).success).toBe(true);
    expect(inputSchema.safeParse({ operation: "upsert", id: "a" }).success).toBe(false);
    expect(inputSchema.safeParse({ operation: "delete", id: "a" }).success).toBe(true);
    if (captured.handler === undefined) {
      throw new Error("Handler should be defined");
    }
    await captured.handler({ operation: "delete", id: "a" });
    expect(execute).toHaveBeenCalledWith({ operation: "delete", id: "a" }, expect.any(Object));
  });

  test("flattens plain object unions for direct MCP arguments", async () => {
    const schema = z.union([
      z.object({ backend: z.literal("local"), pattern: z.string() }),
      z.object({ backend: z.literal("database"), query_file: z.string() }),
    ]);
    const execute = vi.fn().mockReturnValue({ success: true, data: "ok" });
    const feature: Feature<typeof schema> = {
      name: "plain_union_tool",
      description: "Plain union tool",
      schema,
      execute,
    };
    const { server, captured } = makeServer();
    registerFeatureAsTool(server, feature);
    const inputSchema = (captured.config as { inputSchema: z.ZodType }).inputSchema;

    expect(inputSchema).toBeInstanceOf(z.ZodObject);
    expect(inputSchema.safeParse({ backend: "local", pattern: "call($X)" }).success).toBe(true);
    expect(inputSchema.safeParse({ backend: "local", query_file: "query.ql" }).success).toBe(false);
    if (captured.handler === undefined) {
      throw new Error("Handler should be defined");
    }
    await captured.handler({ backend: "database", query_file: "query.ql" });
    expect(execute).toHaveBeenCalledWith(
      { backend: "database", query_file: "query.ql" },
      expect.any(Object),
    );
  });

  test("unwraps primitive schema input before executing the feature", async () => {
    const execute = vi.fn().mockReturnValue({ success: true, data: "ok" });
    const simpleSchema = z.string();
    const simpleFeature: Feature<typeof simpleSchema> = {
      name: "simple_tool",
      description: "Simple tool",
      schema: simpleSchema,
      execute,
    };

    const { server, captured } = makeServer();
    registerFeatureAsTool(server, simpleFeature);

    if (captured.handler === undefined) {
      throw new Error("Handler should be defined");
    }
    await captured.handler({ input: "value" });

    expect(execute).toHaveBeenCalledWith("value", expect.any(Object));
  });

  test("handler returns data as JSON when no message", async () => {
    const dataFeature: Feature<typeof testSchema> = {
      ...mockFeature,
      execute: () => ({ success: true, data: { key: "value" } }),
    };

    const { server, captured } = makeServer();
    registerFeatureAsTool(server, dataFeature);

    if (captured.handler === undefined) {
      throw new Error("Handler should be defined");
    }

    const result = (await captured.handler({ param1: "test" })) as {
      content: { type: string; text: string }[];
      isError: boolean;
    };

    expect(result.content[0]?.text).toContain('"key"');
    expect(result.content[0]?.text).toContain('"value"');
  });

  test("bounds oversized MCP responses without leaking the original payload", () => {
    vi.stubEnv("SRC_MAX_RESULT_BYTES", "64");

    const result = formatFeatureResult({
      success: true,
      data: { source: "x".repeat(500) },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      schema_version: 1,
      success: false,
      error: "Tool result exceeded the configured output limit",
      meta: {
        local_only: true,
        bounded: true,
        provenance: "local-analysis",
      },
    });
    expect(result.content[0]?.text).not.toContain("xxxxx");
  });

  test("rejects a feature result that violates its declared output schema", async () => {
    const constrainedSchema = createFeatureResultSchema(z.object({ value: z.string() }).strict());
    const invalidFeature: Feature<typeof testSchema> = {
      ...mockFeature,
      outputSchema: constrainedSchema,
      execute: () => ({ success: true, data: { value: 42 } }),
    };
    const { server, captured } = makeServer();
    registerFeatureAsTool(server, invalidFeature);

    if (captured.handler === undefined) {
      throw new Error("Handler should be defined");
    }
    const result = (await captured.handler({ param1: "test" })) as {
      isError: boolean;
      structuredContent: { error?: string };
    };

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toBe("Tool returned an invalid structured output");
  });
});
