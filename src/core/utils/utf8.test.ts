import { describe, expect, test } from "vitest";

import { truncateUtf8, truncateUtf8WithStatus } from "@core/utils/utf8";

describe("UTF-8 truncation", () => {
  test("preserves complete code points within the byte budget", () => {
    expect(truncateUtf8("ab😀cd", 6)).toBe("ab😀");
    expect(
      Buffer.byteLength(truncateUtf8("ab😀cd", 5), "utf8"),
    ).toBeLessThanOrEqual(5);
    expect(truncateUtf8("ab😀cd", 5)).toBe("ab");
  });

  test("reports truncation and handles non-positive budgets", () => {
    expect(truncateUtf8WithStatus("hello", 4)).toEqual({
      text: "hell",
      truncated: true,
    });
    expect(truncateUtf8WithStatus("hello", 5)).toEqual({
      text: "hello",
      truncated: false,
    });
    expect(truncateUtf8("hello", 0)).toBe("");
  });

  test("handles large multibyte input in one bounded buffer pass", () => {
    const result = truncateUtf8("😀".repeat(100_000), 100_001);
    expect(Buffer.byteLength(result, "utf8")).toBe(100_000);
    expect(result.endsWith("😀")).toBe(true);
  });
});
