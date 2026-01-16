import { describe, expect, test } from "bun:test";
import { execute, echoSchema } from "./index";

describe("echo feature", () => {
  test("should return echoed message", () => {
    const input = echoSchema.parse({ message: "Hello World" });
    const result = execute(input);

    expect(result.success).toBe(true);
    expect(result.message).toBe("Echo: Hello World");
    expect(result.data).toEqual({ original: "Hello World" });
  });

  test("should validate input schema", () => {
    expect(() => echoSchema.parse({})).toThrow();
    expect(() => echoSchema.parse({ message: 123 })).toThrow();
  });
});
