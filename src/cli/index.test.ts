import { describe, expect, test, vi } from "vitest";

vi.mock("citty", () => ({
  defineCommand: vi.fn(),
  runMain: vi.fn(),
}));

import { runCLI } from "@cli/index";
import { runMain } from "citty";

describe("CLI Index", () => {
  test("runCLI is a function", () => {
    expect(typeof runCLI).toBe("function");
  });

  test("runCLI calls and awaits runMain", async () => {
    await runCLI();
    expect(runMain).toHaveBeenCalled();
  });
});
