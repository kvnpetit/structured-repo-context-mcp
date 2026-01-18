import { describe, expect, test, vi } from "vitest";
import { serveCommand } from "@cli/commands/serve.command";
import type { CommandMeta } from "citty";

vi.mock("@/server", () => ({
  startServer: vi.fn().mockResolvedValue(undefined),
}));

describe("Serve Command", () => {
  test("has correct meta", () => {
    const meta = serveCommand.meta as CommandMeta;

    expect(meta.name).toBe("serve");
    expect(meta.description).toBe("Start the MCP server");
  });

  test("has transport arg with default stdio", () => {
    const args = serveCommand.args as Record<string, { default?: string }>;

    expect(args.transport).toBeDefined();
    expect(args.transport?.default).toBe("stdio");
  });

  test("run calls startServer", async () => {
    const { startServer } = await import("@/server");

    await serveCommand.run?.(
      {} as Parameters<NonNullable<typeof serveCommand.run>>[0],
    );

    expect(startServer).toHaveBeenCalled();
  });
});
