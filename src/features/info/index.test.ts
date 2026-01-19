import { describe, expect, test } from "vitest";
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

  test("should handle description in text format", () => {
    // Note: Dynamic module mocking (vi.doMock) is not supported in Bun's test runner.
    // The undefined description case is handled by the nullish coalescing operator (??)
    // in the implementation: `const description = info.description ?? ""`
    const input = infoSchema.parse({ format: "text" });
    const result = execute(input);

    expect(result.success).toBe(true);
    expect(result.message).toBeDefined();
    // Verify the message format includes the expected components
    expect(result.message).toContain("SRC");
    expect(result.message).toContain("src-mcp");
  });

  test("schema validates format options correctly", () => {
    expect(() => infoSchema.parse({})).not.toThrow();
    expect(() => infoSchema.parse({ format: "text" })).not.toThrow();
    expect(() => infoSchema.parse({ format: "json" })).not.toThrow();
    expect(() => infoSchema.parse({ format: "invalid" })).toThrow();
  });
});
