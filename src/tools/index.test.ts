import { describe, expect, test, vi } from "vitest";
import { registerTools } from "@tools";
import { features } from "@features";

describe("Tool Registration", () => {
  function makeServer() {
    const calls: { name: string; config: Record<string, unknown> }[] = [];
    const mock = vi.fn(
      (name: string, config: Record<string, unknown>, _handler: unknown) => {
        calls.push({ name, config });
      },
    );
    return { server: { registerTool: mock } as never, mock, calls };
  }

  test("registers all features as tools", () => {
    const { server, mock } = makeServer();
    registerTools(server);
    expect(mock).toHaveBeenCalledTimes(features.length);
  });

  test("tool names match feature names", () => {
    const { server, calls } = makeServer();
    registerTools(server);

    for (const feature of features) {
      expect(calls.map((c) => c.name)).toContain(feature.name);
    }
  });

  test("tool descriptions are passed correctly", () => {
    const { server, calls } = makeServer();
    registerTools(server);

    for (const feature of features) {
      const call = calls.find((c) => c.name === feature.name);
      expect(
        (call?.config as { description: string } | undefined)?.description,
      ).toBe(feature.description);
    }
  });
});
