import { afterEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isPathWithin,
  hasConfiguredAllowedRoots,
  getMaxFileBytes,
  readSecureTextFile,
  resolveSecureDirectory,
  resolveSecureFile,
  safeErrorMessage,
} from "./paths";

const originalAllowedRoots = process.env.SRC_ALLOWED_ROOTS;

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-security-test-"));
}

afterEach(() => {
  if (originalAllowedRoots === undefined) {
    delete process.env.SRC_ALLOWED_ROOTS;
  } else {
    process.env.SRC_ALLOWED_ROOTS = originalAllowedRoots;
  }
});

describe("path containment", () => {
  test("project containment narrows a broader deployment root", () => {
    const root = makeTempDir();
    try {
      const project = path.join(root, "project");
      fs.mkdirSync(project);
      const sibling = path.join(root, "sibling.ts");
      fs.writeFileSync(sibling, "harmless outside-project marker");
      process.env.SRC_ALLOWED_ROOTS = root;
      expect(resolveSecureFile(sibling, project).ok).toBe(false);
      expect(readSecureTextFile(sibling, project).ok).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a supplied project cannot bypass deployment roots", () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    try {
      const file = path.join(outside, "marker.ts");
      fs.writeFileSync(file, "harmless marker");
      for (const roots of [root, ";,"]) {
        process.env.SRC_ALLOWED_ROOTS = roots;
        expect(resolveSecureFile(file, outside).ok).toBe(false);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("does not confuse sibling prefixes with descendants", () => {
    const root = path.join("workspace", "repo");
    const sibling = path.join("workspace", "repo2");
    expect(isPathWithin(root, sibling)).toBe(false);
  });

  test("rejects a file outside the configured workspace", () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    try {
      fs.writeFileSync(path.join(outside, "outside.ts"), "export const x = 1;");
      process.env.SRC_ALLOWED_ROOTS = root;
      const result = resolveSecureFile(path.join(outside, "outside.ts"));
      expect(result).toEqual({
        ok: false,
        error: "Path is outside the allowed workspace",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("accepts files within the configured workspace", () => {
    const root = makeTempDir();
    try {
      const file = path.join(root, "inside.ts");
      fs.writeFileSync(file, "export const x = 1;");
      process.env.SRC_ALLOWED_ROOTS = root;
      expect(resolveSecureFile(file)).toEqual({ ok: true, path: file });
      expect(resolveSecureDirectory(root)).toEqual({ ok: true, path: root });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when a configured root does not exist", () => {
    const outside = makeTempDir();
    try {
      const missingRoot = path.join(outside, "missing-root");
      const file = path.join(outside, "outside.ts");
      fs.writeFileSync(file, "export const x = 1;");
      process.env.SRC_ALLOWED_ROOTS = missingRoot;

      expect(resolveSecureFile(file)).toEqual({
        ok: false,
        error: "Path is outside the allowed workspace",
      });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("fails closed when the configured allow-list contains no usable root", () => {
    const outside = makeTempDir();
    try {
      const file = path.join(outside, "outside.ts");
      fs.writeFileSync(file, "export const x = 1;");
      process.env.SRC_ALLOWED_ROOTS = ";,";

      expect(hasConfiguredAllowedRoots()).toBe(true);
      expect(resolveSecureFile(file)).toEqual({
        ok: false,
        error: "Path is outside the allowed workspace",
      });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("keeps path containment stable for adversarial relative segments", () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    try {
      process.env.SRC_ALLOWED_ROOTS = root;
      const values = [
        "../outside.ts",
        "..\\outside.ts",
        `${path.basename(root)}-sibling/secret.ts`,
        "./nested/../../outside.ts",
        "nested/../../../outside.ts",
        "nested/./safe.ts",
      ];
      for (const value of values) {
        const resolved = path.resolve(root, value);
        if (resolved.startsWith(outside)) {
          fs.writeFileSync(resolved, "secret");
        }
        const result = resolveSecureFile(resolved, root);
        if (path.relative(root, resolved).startsWith(`..${path.sep}`)) {
          expect(result.ok).toBe(false);
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects symlinks that escape a project root", () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    try {
      const outsideFile = path.join(outside, "secret.ts");
      const link = path.join(root, "link.ts");
      fs.writeFileSync(outsideFile, "secret");
      try {
        fs.symlinkSync(outsideFile, link, "file");
      } catch {
        return;
      }
      const result = resolveSecureFile(link, root);
      expect(result.ok).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("enforces the text file size limit", () => {
    const root = makeTempDir();
    const originalLimit = process.env.SRC_MAX_FILE_BYTES;
    try {
      process.env.SRC_MAX_FILE_BYTES = "3";
      const file = path.join(root, "large.ts");
      fs.writeFileSync(file, "1234");
      const result = readSecureTextFile(file);
      expect(result).toEqual({
        ok: false,
        error: "File exceeds the 3-byte safety limit",
      });
    } finally {
      if (originalLimit === undefined) {
        delete process.env.SRC_MAX_FILE_BYTES;
      } else {
        process.env.SRC_MAX_FILE_BYTES = originalLimit;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps an unsafe file-size override bounded", () => {
    const originalLimit = process.env.SRC_MAX_FILE_BYTES;
    try {
      process.env.SRC_MAX_FILE_BYTES = "999999999999";
      expect(getMaxFileBytes()).toBe(10 * 1024 * 1024);
    } finally {
      if (originalLimit === undefined) {
        delete process.env.SRC_MAX_FILE_BYTES;
      } else {
        process.env.SRC_MAX_FILE_BYTES = originalLimit;
      }
    }
  });

  test("safeErrorMessage removes absolute paths but preserves short diagnostics", () => {
    expect(safeErrorMessage(new Error("parser failed"), "fallback")).toBe("parser failed");
    expect(safeErrorMessage(new Error("failed at C:\\Users\\kevin\\secret.ts"), "fallback")).toBe(
      "fallback",
    );
    expect(safeErrorMessage("provider unavailable", "fallback")).toBe("provider unavailable");
  });
});
