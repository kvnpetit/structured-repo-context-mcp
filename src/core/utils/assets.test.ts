import { existsSync } from "fs";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  assetExists,
  clearAssetsDirCache,
  getAssetPath,
  getAssetsDir,
  loadJsonConfig,
} from "@core/utils";

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
      const path = getAssetPath("languages.json");
      expect(path).toContain("assets");
      expect(path).toContain("languages.json");
    });

    test("handles multiple segments", () => {
      const path = getAssetPath("queries", "javascript", "tags.scm");
      expect(path).toContain("queries");
      expect(path).toContain("javascript");
      expect(path).toContain("tags.scm");
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
