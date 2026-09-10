import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import * as nodeFs from "node:fs";

import { hasContentSource, readContent } from "@features/utils";

vi.mock("node:fs", { spy: true });

describe("Content Utilities", () => {
  let tempFilePath: string;
  const testContent = "const x = 1;\nconst y = 2;";

  beforeAll(() => {
    tempFilePath = join(tmpdir(), `test-content-${String(Date.now())}.ts`);
    writeFileSync(tempFilePath, testContent);
  });

  afterAll(() => {
    try {
      unlinkSync(tempFilePath);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("readContent", () => {
    test("returns content when content string is provided", () => {
      const result = readContent(undefined, "test content");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe("test content");
      }
    });

    test("prefers content over file path when both provided", () => {
      const result = readContent(tempFilePath, "direct content");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe("direct content");
      }
    });

    test("reads content from file when only file path provided", () => {
      const result = readContent(tempFilePath);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe(testContent);
      }
    });

    test("returns error for non-existent file", () => {
      const result = readContent("/non/existent/path.ts");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Failed to read file");
      }
    });

    test("returns error when neither file path nor content provided", () => {
      const result = readContent();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Either file_path or content must be provided");
      }
    });

    test("handles empty string content", () => {
      const result = readContent(undefined, "");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe("");
      }
    });

    test("bounds direct content using the same limit as file reads", () => {
      vi.stubEnv("SRC_MAX_FILE_BYTES", "3");

      const result = readContent(undefined, "1234");

      expect(result).toEqual({
        success: false,
        error: "Content exceeds the 3-byte safety limit",
      });
    });
  });

  describe("hasContentSource", () => {
    test("returns true when file path provided", () => {
      expect(hasContentSource("/some/path.ts")).toBe(true);
    });

    test("returns true when content provided", () => {
      expect(hasContentSource(undefined, "content")).toBe(true);
    });

    test("returns true when both provided", () => {
      expect(hasContentSource("/some/path.ts", "content")).toBe(true);
    });

    test("returns false when neither provided", () => {
      expect(hasContentSource()).toBe(false);
    });

    test("returns false when both undefined", () => {
      expect(hasContentSource(undefined, undefined)).toBe(false);
    });
  });
});

describe("Content Utilities - Error Handling", () => {
  let readErrorPath: string;

  beforeAll(() => {
    readErrorPath = join(tmpdir(), `test-content-errors-${String(Date.now())}.ts`);
    writeFileSync(readErrorPath, "const value = 1;");
  });

  afterAll(() => {
    try {
      unlinkSync(readErrorPath);
    } catch {
      // Ignore cleanup errors
    }
  });

  test("handles non-Error thrown values", () => {
    vi.spyOn(nodeFs, "readFileSync").mockImplementation(() => {
      throw "string error"; // Throw a string instead of Error
    });

    const result = readContent(readErrorPath);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed to read file");
      expect(result.error).toContain("string error");
    }

    vi.restoreAllMocks();
  });

  test("handles thrown numbers", () => {
    vi.spyOn(nodeFs, "readFileSync").mockImplementation(() => {
      throw 42; // Throw a number
    });

    const result = readContent(readErrorPath);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed to read file");
      expect(result.error).toContain("42");
    }

    vi.restoreAllMocks();
  });

  test("handles thrown objects", () => {
    vi.spyOn(nodeFs, "readFileSync").mockImplementation(() => {
      throw { code: "EACCES", message: "Permission denied" };
    });

    const result = readContent(readErrorPath);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed to read file");
    }

    vi.restoreAllMocks();
  });
});
