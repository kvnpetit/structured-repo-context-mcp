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

  test("registers feature with correct name", () => {
    let capturedName: string | undefined;
    const toolMock = vi.fn(
      (name: string, _desc: string, _schema: unknown, _handler: unknown) => {
        capturedName = name;
      },
    );
    const mockServer = { tool: toolMock };

    registerFeatureAsTool(mockServer as never, mockFeature);

    expect(toolMock).toHaveBeenCalledTimes(1);
    expect(capturedName).toBe("test_tool");
  });

  test("registers feature with correct description", () => {
    let capturedDesc: string | undefined;
    const toolMock = vi.fn(
      (_name: string, desc: string, _schema: unknown, _handler: unknown) => {
        capturedDesc = desc;
      },
    );
    const mockServer = { tool: toolMock };

    registerFeatureAsTool(mockServer as never, mockFeature);

    expect(capturedDesc).toBe("A test tool");
  });

  test("converts Zod schema to MCP schema with correct shape", () => {
    let capturedSchema: Record<string, unknown> | undefined;
    const toolMock = vi.fn(
      (
        _name: string,
        _desc: string,
        schema: Record<string, unknown>,
        _handler: unknown,
      ) => {
        capturedSchema = schema;
      },
    );
    const mockServer = { tool: toolMock };

    registerFeatureAsTool(mockServer as never, mockFeature);

    expect(capturedSchema).toBeDefined();
    expect(capturedSchema).toHaveProperty("param1");
    expect(capturedSchema).toHaveProperty("param2");
  });

  test("handler returns correct format for success", async () => {
    let capturedHandler: ((params: unknown) => Promise<unknown>) | undefined;
    const toolMock = vi.fn(
      (
        _name: string,
        _desc: string,
        _schema: unknown,
        handler: (params: unknown) => Promise<unknown>,
      ) => {
        capturedHandler = handler;
      },
    );
    const mockServer = { tool: toolMock };

    registerFeatureAsTool(mockServer as never, mockFeature);

    expect(capturedHandler).toBeDefined();
    if (capturedHandler === undefined) {
      throw new Error("Handler should be defined");
    }
    const result = (await capturedHandler({ param1: "test" })) as {
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
      execute: () => ({
        success: false,
        error: "Something went wrong",
      }),
    };

    let capturedHandler: ((params: unknown) => Promise<unknown>) | undefined;
    const toolMock = vi.fn(
      (
        _name: string,
        _desc: string,
        _schema: unknown,
        handler: (params: unknown) => Promise<unknown>,
      ) => {
        capturedHandler = handler;
      },
    );
    const mockServer = { tool: toolMock };

    registerFeatureAsTool(mockServer as never, errorFeature);

    if (capturedHandler === undefined) {
      throw new Error("Handler should be defined");
    }
    const result = (await capturedHandler({ param1: "test" })) as {
      content: { type: string; text: string }[];
      isError: boolean;
    };

    expect(result.isError).toBe(true);
  });
});
