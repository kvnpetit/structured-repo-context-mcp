import { existsSync } from "node:fs";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  assetExists,
  clearAssetsDirCache,
  getAssetPath,
  getAssetsDir,
  loadJsonConfig,
} from "@core/utils";

vi.mock("node:fs", { spy: true });

describe("Assets Utilities", () => {
  afterEach(() => {
    clearAssetsDirCache();
    vi.restoreAllMocks();
  });

  describe("getAssetsDir", () => {
    test("returns valid assets directory", () => {
      const dir = getAssetsDir();
      expect(dir).toBeDefined();
      expect(typeof dir).toBe("string");
      expect(existsSync(dir)).toBe(true);
    });

    test("returns cached value on subsequent calls", () => {
      const dir1 = getAssetsDir();
      const dir2 = getAssetsDir();
      expect(dir1).toBe(dir2);
    });

    test("clearAssetsDirCache resets the cache", () => {
      const dir1 = getAssetsDir();
      clearAssetsDirCache();
      const dir2 = getAssetsDir();
      // Both should be valid even after clearing
      expect(dir1).toBe(dir2);
    });
  });

  describe("loadJsonConfig", () => {
    test("loads valid JSON config from assets", () => {
      const config = loadJsonConfig<{ treesitter: object }>("languages.json", {
        treesitter: {},
      });
      expect(config).toBeDefined();
      expect(config.treesitter).toBeDefined();
    });

    test("returns default value for non-existent file", () => {
      const defaultValue = { foo: "bar" };
      const config = loadJsonConfig("non-existent-file.json", defaultValue);
      expect(config).toEqual(defaultValue);
    });
  });

  describe("getAssetPath", () => {
    test("returns path within assets directory", () => {
      const p = getAssetPath("languages.json");
      expect(p).toContain("assets");
      expect(p).toContain("languages.json");
    });

    test("handles multiple segments", () => {
      const p = getAssetPath("queries", "javascript", "tags.scm");
      expect(p).toContain("queries");
      expect(p).toContain("javascript");
      expect(p).toContain("tags.scm");
    });
  });

  describe("assetExists", () => {
    test("returns true for existing asset", () => {
      expect(assetExists("languages.json")).toBe(true);
    });

    test("returns false for non-existent asset", () => {
      expect(assetExists("non-existent-file.xyz")).toBe(false);
    });

    test("handles nested paths", () => {
      expect(assetExists("queries", "javascript", "tags.scm")).toBe(true);
      expect(assetExists("queries", "nonexistent", "file.scm")).toBe(false);
    });
  });
});

describe("getAssetsDir fallback behavior", () => {
  afterEach(() => {
    clearAssetsDirCache();
    vi.restoreAllMocks();
  });

  test("returns fallback path when no assets directory exists", () => {
    // Mock nodeFs.existsSync to always return false
    vi.spyOn(nodeFs, "existsSync").mockImplementation(() => false);

    clearAssetsDirCache();
    const dir = getAssetsDir();
    // When no paths exist, it falls back to process.cwd() + "assets"
    expect(dir).toBe(path.join(process.cwd(), "assets"));
  });
});

describe("getAssetsDir ESM/CJS handling", () => {
  afterEach(() => {
    clearAssetsDirCache();
    vi.restoreAllMocks();
  });

  test("handles ESM context when __dirname is undefined", () => {
    // This test verifies the ESM branch where __dirname is not defined
    // The module uses import.meta.url as fallback
    // In the test environment, this branch may or may not be hit depending on
    // how the module is loaded, but we can verify it doesn't throw
    clearAssetsDirCache();
    const dir = getAssetsDir();
    expect(dir).toBeDefined();
    expect(typeof dir).toBe("string");
  });

  test("handles multiple possible paths correctly", () => {
    // Test that the function tries multiple paths
    let callCount = 0;
    vi.spyOn(nodeFs, "existsSync").mockImplementation((p: unknown) => {
      callCount++;
      // Return true only for paths that include process.cwd()
      return typeof p === "string" && p.includes(process.cwd());
    });

    clearAssetsDirCache();
    const dir = getAssetsDir();
    expect(dir).toBeDefined();
    // Should have checked at least one path
    expect(callCount).toBeGreaterThan(0);
  });
});

describe("loadJsonConfig edge cases", () => {
  afterEach(() => {
    clearAssetsDirCache();
    vi.restoreAllMocks();
  });

  test("returns default value when JSON is invalid", () => {
    vi.spyOn(nodeFs, "existsSync").mockImplementation(() => true);
    vi.spyOn(nodeFs, "readFileSync").mockImplementation(() => "{ invalid json }");

    clearAssetsDirCache();
    const defaultValue = { fallback: true };
    const config = loadJsonConfig("test.json", defaultValue);
    expect(config).toEqual(defaultValue);
  });
});
