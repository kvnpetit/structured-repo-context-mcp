import { describe, expect, test, vi } from "vitest";
import { registerFeatureAsTool } from "@tools/adapter";
import { z } from "zod";
import type { Feature } from "@features/types";

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
      handler: undefined as ((params: unknown) => Promise<unknown>) | undefined,
    };
    const mock = vi.fn(
      (
        name: string,
        config: Record<string, unknown>,
        handler: (params: unknown) => Promise<unknown>,
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
    expect((captured.config as { description: string }).description).toBe(
      "A test tool",
    );
  });

  test("converts Zod schema to MCP schema with correct shape", () => {
    const { server, captured } = makeServer();
    registerFeatureAsTool(server, mockFeature);
    const inputSchema = (
      captured.config as { inputSchema: Record<string, unknown> }
    ).inputSchema;
    expect(inputSchema).toBeDefined();
    expect(inputSchema).toHaveProperty("param1");
    expect(inputSchema).toHaveProperty("param2");
  });

  test("handler returns correct format for success", async () => {
    const { server, captured } = makeServer();
    registerFeatureAsTool(server, mockFeature);

    expect(captured.handler).toBeDefined();
    if (captured.handler === undefined) throw new Error("Handler should be defined");

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

    if (captured.handler === undefined) throw new Error("Handler should be defined");

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

    if (captured.handler === undefined) throw new Error("Handler should be defined");

    const result = (await captured.handler({ param1: "test" })) as {
      content: { type: string; text: string }[];
      isError: boolean;
    };

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("Async: test");
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

    const inputSchema = (
      captured.config as { inputSchema: Record<string, unknown> }
    ).inputSchema;
    expect(inputSchema).toBeDefined();
    expect(inputSchema).toHaveProperty("input");
  });

  test("handler returns data as JSON when no message", async () => {
    const dataFeature: Feature<typeof testSchema> = {
      ...mockFeature,
      execute: () => ({ success: true, data: { key: "value" } }),
    };

    const { server, captured } = makeServer();
    registerFeatureAsTool(server, dataFeature);

    if (captured.handler === undefined) throw new Error("Handler should be defined");

    const result = (await captured.handler({ param1: "test" })) as {
      content: { type: string; text: string }[];
      isError: boolean;
    };

    expect(result.content[0]?.text).toContain('"key"');
    expect(result.content[0]?.text).toContain('"value"');
  });
});
