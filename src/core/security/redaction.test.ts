import { describe, expect, test } from "vitest";

import { redactSourceText, redactStructuredValue } from "@core/security";

describe("source redaction", () => {
  test("redacts common assignments and provider token formats", () => {
    const result = redactSourceText(
      'const apiKey = "super secret"; const token = "ghp_abcdefghijklmnopqrstuvwxyz123456"; authorization: Bearer abcdefghijklmnop',
    );

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("super secret");
    expect(result.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(result.text).not.toContain("abcdefghijklmnop");
    expect(result.text).toContain("[REDACTED]");
  });

  test("leaves ordinary source unchanged", () => {
    const source =
      "function authenticate(token: string, password: string): boolean { return true; }";
    expect(redactSourceText(source)).toEqual({
      text: source,
      redacted: false,
    });
  });

  test("still redacts unquoted secret assignments", () => {
    const result = redactSourceText("token: actual-secret-value\npassword: SuperSecret123");

    expect(result).toEqual({
      text: "token: [REDACTED]\npassword: [REDACTED]",
      redacted: true,
    });
  });

  test("redacts strings inside structured results without changing shape", () => {
    const result = redactStructuredValue({
      source: 'const password = "secret";',
      password: "structured-secret",
      nested: [{ value: "ghp_12345678901234567890" }],
      count: 2,
    });

    expect(result.redacted).toBe(true);
    expect(result.value).toEqual({
      source: 'const password = "[REDACTED]";',
      password: "[REDACTED]",
      nested: [{ value: "[REDACTED TOKEN]" }],
      count: 2,
    });
  });
});
