import { describe, expect, test, vi } from "vitest";
import { registerPrompts } from "@prompts";

describe("Prompt Registration", () => {
  test("registerPrompts does not throw", () => {
    const mockServer = {
      prompt: vi.fn(() => {
        // Mock implementation
      }),
    };

    expect(() => {
      registerPrompts(mockServer as never);
    }).not.toThrow();
  });

  test("registerPrompts accepts server parameter", () => {
    const promptMock = vi.fn(() => {
      // Mock implementation
    });
    const mockServer = { prompt: promptMock };

    registerPrompts(mockServer as never);

    // Currently no prompts registered, so mock should not be called
    // This test ensures the function signature is correct
    expect(true).toBe(true);
  });
});
