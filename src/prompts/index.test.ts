import { describe, expect, test, vi } from "vitest";
import { registerPrompts } from "@prompts";

type PromptCallback = () => {
  messages: { role: string; content: { type: string; text: string } }[];
};

function getCallback(name: string): PromptCallback {
  const registerPromptMock = vi.fn();
  registerPrompts({ registerPrompt: registerPromptMock } as never);
  const call = registerPromptMock.mock.calls.find((c) => c[0] === name);
  return call?.[2] as PromptCallback;
}

describe("Prompt Registration", () => {
  test("registerPrompts does not throw", () => {
    const mockServer = {
      registerPrompt: vi.fn(),
    };

    expect(() => {
      registerPrompts(mockServer as never);
    }).not.toThrow();
  });

  test("registerPrompts registers 7 prompts", () => {
    const registerPromptMock = vi.fn();
    const mockServer = { registerPrompt: registerPromptMock };

    registerPrompts(mockServer as never);

    // The catalog includes the overview, search workflow, tips, and four
    // bounded local workflows for onboarding, architecture, security, and
    // refactor-impact analysis.
    expect(registerPromptMock).toHaveBeenCalledTimes(7);
    expect(registerPromptMock).toHaveBeenCalledWith(
      "src-overview",
      expect.any(Object),
      expect.any(Function),
    );
    expect(registerPromptMock).toHaveBeenCalledWith(
      "code-search-workflow",
      expect.any(Object),
      expect.any(Function),
    );
    expect(registerPromptMock).toHaveBeenCalledWith(
      "search-tips",
      expect.any(Object),
      expect.any(Function),
    );
    for (const name of [
      "project-onboarding",
      "architecture-review",
      "security-review",
      "refactor-impact",
    ]) {
      expect(registerPromptMock).toHaveBeenCalledWith(
        name,
        expect.any(Object),
        expect.any(Function),
      );
    }
  });

  test("src-overview callback returns message with SRC content", () => {
    const callback = getCallback("src-overview");
    const result = callback();

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.content.type).toBe("text");
    expect(result.messages[0]?.content.text).toContain("SRC");
  });

  test("code-search-workflow callback returns message with search_code", () => {
    const callback = getCallback("code-search-workflow");
    const result = callback();

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.content.type).toBe("text");
    expect(result.messages[0]?.content.text).toContain("search_code");
  });

  test("search-tips callback returns message with query tips", () => {
    const callback = getCallback("search-tips");
    const result = callback();

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.content.type).toBe("text");
    expect(result.messages[0]?.content.text).toContain("query");
  });

  test.each([
    ["project-onboarding", "get_project_context"],
    ["architecture-review", "get_symbol_graph"],
    ["security-review", "instruction_signals"],
    ["refactor-impact", "analyze_impact"],
  ])("%s callback includes %s", (name, expected) => {
    const callback = getCallback(name);
    const result = callback();

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.content.type).toBe("text");
    expect(result.messages[0]?.content.text).toContain(expected);
  });
});
