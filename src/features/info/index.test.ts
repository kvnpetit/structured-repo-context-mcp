import { describe, expect, test, vi } from "vitest";
import { execute, getServerInfo, infoSchema } from "@features/info";

describe("info feature", () => {
  test("should return server info as text", () => {
    const input = infoSchema.parse({});
    const result = execute(input);

    expect(result.success).toBe(true);
    expect(result.message).toContain("src-mcp");
  });

  test("should return server info as JSON", () => {
    const input = infoSchema.parse({ format: "json" });
    const result = execute(input);

    expect(result.success).toBe(true);
    expect(result.message).toBeDefined();

    const parsed = JSON.parse(result.message ?? "{}") as Record<
      string,
      unknown
    >;
    expect(parsed).toHaveProperty("name");
    expect(parsed).toHaveProperty("fullName");
    expect(parsed).toHaveProperty("version");
  });

  test("getServerInfo should return config values", () => {
    const info = getServerInfo();

    expect(info.name).toBe("src-mcp");
    expect(info.fullName).toBe("SRC (Structured Repo Context)");
    expect(info.version).toBe("1.0.0");
  });

  test("should handle undefined description in text format", async () => {
    // Mock config with undefined description
    vi.doMock("@config", () => ({
      config: {
        name: "test-server",
        fullName: "Test Server",
        version: "0.0.1",
        description: undefined,
      },
    }));

    // Re-import to get mocked version
    const { execute: mockedExecute } = await import("@features/info");
    const input = infoSchema.parse({ format: "text" });
    const result = mockedExecute(input);

    expect(result.success).toBe(true);
    // Should not throw when description is undefined
    expect(result.message).toBeDefined();

    vi.doUnmock("@config");
  });
});
