import { describe, expect, test } from "bun:test";
import { execute, getServerInfo, infoSchema } from "./index";

describe("info feature", () => {
  test("should return server info as text", () => {
    const input = infoSchema.parse({});
    const result = execute(input);

    expect(result.success).toBe(true);
    expect(result.message).toContain("my-mcp-server");
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
    expect(parsed).toHaveProperty("version");
  });

  test("getServerInfo should return config values", () => {
    const info = getServerInfo();

    expect(info.name).toBe("my-mcp-server");
    expect(info.version).toBe("1.0.0");
  });
});
