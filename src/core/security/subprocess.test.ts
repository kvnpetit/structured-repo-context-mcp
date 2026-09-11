import { describe, expect, test } from "vitest";

import { createSafeLocalToolEnvironment } from "@core/security/subprocess";

describe("safe local subprocess environment", () => {
  test("keeps runtime settings but excludes credentials and arbitrary variables", () => {
    const environment = createSafeLocalToolEnvironment({
      PATH: "C:\\tools",
      HOME: "C:\\Users\\test",
      LANG: "fr_FR.UTF-8",
      OPENAI_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
      DATABASE_PASSWORD: "secret",
      PROJECT_ROOT: "C:\\project",
      NODE_OPTIONS: "--require malicious.js",
    });

    expect(environment).toMatchObject({
      PATH: "C:\\tools",
      HOME: "C:\\Users\\test",
      LANG: "fr_FR.UTF-8",
    });
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(environment).not.toHaveProperty("DATABASE_PASSWORD");
    expect(environment).not.toHaveProperty("PROJECT_ROOT");
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
  });

  test("filters sensitive names even when their prefix is otherwise allowed", () => {
    const environment = createSafeLocalToolEnvironment({
      LANG: "en_US",
      LANGUAGE_TOKEN: "secret",
      LC_ALL: "C",
      TZ: "UTC",
    });

    expect(environment).toEqual({ LANG: "en_US", LC_ALL: "C", TZ: "UTC" });
  });
});
