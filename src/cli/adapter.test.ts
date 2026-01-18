import { describe, expect, test } from "vitest";
import { featureToCittyCommand } from "@cli/adapter";
import { z } from "zod";
import type { Feature } from "@features/types";
import type { CommandMeta } from "citty";

describe("CLI Adapter", () => {
  test("featureToCittyCommand converts feature to citty command", () => {
    const testSchema = z.object({
      message: z.string().describe("Test message"),
    });

    const testFeature: Feature<typeof testSchema> = {
      name: "test_feature",
      description: "Test feature description",
      schema: testSchema,
      execute: (input) => ({
        success: true,
        message: `Echo: ${input.message}`,
      }),
    };

    const command = featureToCittyCommand(testFeature);
    const meta = command.meta as CommandMeta;

    expect(meta.name).toBe("test_feature");
    expect(meta.description).toBe("Test feature description");
    expect(command.args).toBeDefined();
  });

  test("featureToCittyCommand handles features with multiple args", () => {
    const schema = z.object({
      name: z.string().describe("Name parameter"),
      count: z.string().optional().describe("Count parameter"),
    });

    const feature: Feature<typeof schema> = {
      name: "multi_arg_test",
      description: "Multi-arg test",
      schema,
      execute: () => ({ success: true }),
    };

    const command = featureToCittyCommand(feature);
    const meta = command.meta as CommandMeta;

    expect(meta.name).toBe("multi_arg_test");
    expect(command.args).toBeDefined();
  });
});
