import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { featureToCittyCommand } from "@cli/adapter";
import { createFeatureResultSchema } from "@features/utils";
import type { Feature } from "@features/types";

interface RunnableCommand {
  run?: (context: { args: Record<string, unknown> }) => unknown;
}

async function runCommand(feature: Feature, args: Record<string, unknown>): Promise<void> {
  const command = featureToCittyCommand(feature) as RunnableCommand;
  await command.run?.({ args });
}

function firstLoggedEnvelope(): Record<string, unknown> {
  const firstCall = vi.mocked(console.log).mock.calls[0];
  const output = firstCall?.[0] as unknown;
  if (typeof output !== "string") {
    throw new Error("Expected the CLI to write a JSON result envelope");
  }
  return z.record(z.string(), z.unknown()).parse(JSON.parse(output) as unknown);
}

function firstErrorEnvelope(): Record<string, unknown> {
  const firstCall = vi.mocked(console.error).mock.calls[0];
  const output = firstCall?.[0] as unknown;
  if (typeof output !== "string") {
    throw new Error("Expected the CLI to write a JSON error envelope");
  }
  return z.record(z.string(), z.unknown()).parse(JSON.parse(output) as unknown);
}

describe("CLI Adapter", () => {
  const schema = z.object({
    value: z.string(),
    count: z.number().int().default(1),
  });

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.exitCode = undefined;
  });

  test("exposes feature metadata and arguments", () => {
    const feature: Feature<typeof schema> = {
      name: "test_feature",
      description: "Test feature description",
      schema,
      execute: () => ({ success: true }),
    };

    const command = featureToCittyCommand(feature);
    expect(command.meta).toMatchObject({
      name: "test_feature",
      description: "Test feature description",
    });
    expect(command.args).toMatchObject({
      value: { type: "string", required: true },
      count: { type: "string", default: "1" },
    });
  });

  test("awaits execution and passes normalized values", async () => {
    const execute = vi.fn(async () => {
      await Promise.resolve();
      return {
        success: true as const,
        message: "Async done",
      };
    });
    const feature: Feature<typeof schema> = {
      name: "async_success",
      description: "Async success test",
      schema,
      execute,
    };

    await runCommand(feature, { value: "test", count: "5", _: [] });

    expect(execute).toHaveBeenCalledWith({ value: "test", count: 5 }, undefined);
    expect(console.log).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("prints data-only results", async () => {
    const feature: Feature<typeof schema> = {
      name: "data_success",
      description: "Data success test",
      schema,
      execute: () => ({ success: true, data: { key: "value" } }),
    };

    await runCommand(feature, { value: "test" });

    expect(firstLoggedEnvelope()).toMatchObject({
      schema_version: 1,
      success: true,
      data: { key: "value" },
      meta: { local_only: true, bounded: true },
    });
  });

  test("preserves message and data in the shared result envelope", async () => {
    const feature: Feature<typeof schema> = {
      name: "complete_success",
      description: "Complete success test",
      schema,
      execute: () => ({
        success: true,
        message: "Found one result",
        data: { matches: ["src/index.ts"] },
      }),
    };

    await runCommand(feature, { value: "test" });

    expect(firstLoggedEnvelope()).toMatchObject({
      schema_version: 1,
      success: true,
      message: "Found one result",
      data: { matches: ["src/index.ts"] },
    });
  });

  test("rejects invalid arguments before executing", async () => {
    const execute = vi.fn(() => ({ success: true as const }));
    const feature: Feature<typeof schema> = {
      name: "invalid_input",
      description: "Invalid input test",
      schema,
      execute,
    };

    await runCommand(feature, { count: "not-a-number" });

    expect(execute).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Invalid arguments"));
    expect(process.exitCode).toBe(1);
  });

  test("reports failed feature results without terminating abruptly", async () => {
    const feature: Feature<typeof schema> = {
      name: "feature_failure",
      description: "Feature failure test",
      schema,
      execute: () => ({ success: false, error: "Something went wrong" }),
    };

    await runCommand(feature, { value: "test" });

    expect(firstErrorEnvelope()).toMatchObject({
      schema_version: 1,
      success: false,
      error: "Something went wrong",
    });
    expect(process.exitCode).toBe(1);
  });

  test("normalizes unexpected asynchronous failures like the MCP adapter", async () => {
    const feature: Feature<typeof schema> = {
      name: "async_failure",
      description: "Async failure test",
      schema,
      execute: async () => Promise.reject(new Error("Async failure")),
    };

    await runCommand(feature, { value: "test" });

    expect(firstErrorEnvelope()).toMatchObject({
      schema_version: 1,
      success: false,
      error: "Tool execution failed",
    });
    expect(process.exitCode).toBe(1);
  });

  test("normalizes non-Error rejections like the MCP adapter", async () => {
    const feature: Feature<typeof schema> = {
      name: "string_failure",
      description: "String failure test",
      schema,
      execute: async () => Promise.reject("String failure"),
    };

    await runCommand(feature, { value: "test" });

    expect(firstErrorEnvelope()).toMatchObject({
      schema_version: 1,
      success: false,
      error: "Tool execution failed",
    });
    expect(process.exitCode).toBe(1);
  });

  test("enforces the same feature output schema as MCP", async () => {
    const feature: Feature<typeof schema> = {
      name: "invalid_output",
      description: "Invalid output test",
      schema,
      outputSchema: createFeatureResultSchema(z.object({ value: z.string() }).strict()),
      execute: () => ({ success: true, data: { value: 42 } }),
    };

    await runCommand(feature, { value: "test" });

    expect(firstErrorEnvelope()).toMatchObject({
      schema_version: 1,
      success: false,
      error: "Tool returned an invalid structured output",
    });
    expect(process.exitCode).toBe(1);
  });

  test("enforces the same bounded output contract as MCP", async () => {
    vi.stubEnv("SRC_MAX_RESULT_BYTES", "64");
    const feature: Feature<typeof schema> = {
      name: "oversized_output",
      description: "Oversized output test",
      schema,
      execute: () => ({ success: true, data: { source: "x".repeat(500) } }),
    };

    await runCommand(feature, { value: "test" });

    expect(firstErrorEnvelope()).toMatchObject({
      schema_version: 1,
      success: false,
      error: "Tool result exceeded the configured output limit",
    });
    expect(process.exitCode).toBe(1);
  });

  test("does not leak unexpected adapter failure details", async () => {
    const feature: Feature<typeof schema> = {
      name: "adapter_failure",
      description: "Adapter failure test",
      schema,
      execute: () => ({ success: true }),
    };
    vi.spyOn(schema, "safeParse").mockImplementation(() => {
      throw new Error("C:\\private\\secret.ts: sensitive source");
    });

    await runCommand(feature, { value: "test" });

    const envelope = firstErrorEnvelope();
    expect(envelope).toMatchObject({
      schema_version: 1,
      success: false,
      error: "Tool execution failed",
    });
    expect(JSON.stringify(envelope)).not.toContain("private");
    expect(process.exitCode).toBe(1);
  });
});
