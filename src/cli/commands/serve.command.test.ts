import { describe, expect, test, vi } from "vitest";
import { serveCommand } from "@cli/commands/serve.command";
import type { CommandMeta } from "citty";

vi.mock("@/server", () => ({
  startServer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@core/embeddings", () => ({
  createIndexWatcher: vi.fn().mockReturnValue({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe("Serve Command", () => {
  test("has correct meta", () => {
    const meta = serveCommand.meta as CommandMeta;

    expect(meta.name).toBe("serve");
    expect(meta.description).toBe("Start the MCP server");
  });

  test("has transport arg with default stdio", () => {
    const args = serveCommand.args as unknown as Record<
      string,
      { default?: string | boolean }
    >;

    expect(args.transport).toBeDefined();
    expect(args.transport?.default).toBe("stdio");
  });

  test("has directory arg with default current directory", () => {
    const args = serveCommand.args as unknown as Record<
      string,
      { default?: string | boolean }
    >;

    expect(args.directory).toBeDefined();
    expect(args.directory?.default).toBe(".");
  });

  test("has watch arg with default true", () => {
    const args = serveCommand.args as unknown as Record<
      string,
      { default?: string | boolean }
    >;

    expect(args.watch).toBeDefined();
    expect(args.watch?.default).toBe(true);
  });

  test("run calls startServer", async () => {
    const { startServer } = await import("@/server");

    await serveCommand.run?.({
      args: {
        _: [],
        transport: "stdio",
        directory: ".",
        watch: false, // Disable watcher for this test
      },
      rawArgs: [],
      cmd: serveCommand,
    });

    expect(startServer).toHaveBeenCalled();
  });
});
