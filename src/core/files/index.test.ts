import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  collectFiles,
  createIgnoreFilter,
  isHidden,
  isSensitiveFileName,
} from "./index";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-files-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("isHidden", () => {
  test("returns true for dot-prefixed names", () => {
    expect(isHidden(".git")).toBe(true);
    expect(isHidden(".env")).toBe(true);
  });

  test("returns false for regular names", () => {
    expect(isHidden("src")).toBe(false);
    expect(isHidden("index.ts")).toBe(false);
  });
});

describe("createIgnoreFilter", () => {
  test("ignores node_modules and .git by default", () => {
    const dir = makeTempDir();
    try {
      const ig = createIgnoreFilter(dir);
      expect(ig.ignores("node_modules/foo")).toBe(true);
      expect(ig.ignores(".git/config")).toBe(true);
      expect(ig.ignores("dist/index.js")).toBe(true);
      expect(ig.ignores("src/index.ts")).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test("reads .gitignore patterns", () => {
    const dir = makeTempDir();
    try {
      fs.writeFileSync(path.join(dir, ".gitignore"), "coverage/\n*.log\n");
      const ig = createIgnoreFilter(dir);
      expect(ig.ignores("coverage/lcov.info")).toBe(true);
      expect(ig.ignores("debug.log")).toBe(true);
      expect(ig.ignores("src/index.ts")).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test("applies extra patterns", () => {
    const dir = makeTempDir();
    try {
      const ig = createIgnoreFilter(dir, ["tmp/", "*.snap"]);
      expect(ig.ignores("tmp/file.ts")).toBe(true);
      expect(ig.ignores("test.snap")).toBe(true);
      expect(ig.ignores("src/index.ts")).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});

describe("isSensitiveFileName", () => {
  test("recognizes common secret material", () => {
    expect(isSensitiveFileName(".env")).toBe(true);
    expect(isSensitiveFileName(".env.local")).toBe(true);
    expect(isSensitiveFileName("server.pem")).toBe(true);
    expect(isSensitiveFileName("id_rsa")).toBe(true);
    expect(isSensitiveFileName("credentials.json")).toBe(true);
  });

  test("does not reject ordinary source files", () => {
    expect(isSensitiveFileName("secrets-manager.ts")).toBe(false);
    expect(isSensitiveFileName("auth.ts")).toBe(false);
  });
});

describe("collectFiles", () => {
  test("collects typescript files recursively", () => {
    const dir = makeTempDir();
    try {
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "src", "index.ts"), "");
      fs.writeFileSync(path.join(dir, "src", "utils.ts"), "");
      fs.writeFileSync(path.join(dir, "README.md"), "");

      const ig = createIgnoreFilter(dir);
      const files = collectFiles(dir, ig, dir);

      const relative = files.map((f) =>
        path.relative(dir, f).replace(/\\/g, "/"),
      );
      expect(relative).toContain("src/index.ts");
      expect(relative).toContain("src/utils.ts");
      expect(relative).toContain("README.md");
    } finally {
      cleanup(dir);
    }
  });

  test("collects configured parser, fallback, and special files", () => {
    const dir = makeTempDir();
    try {
      const expected = [
        "page.html",
        "module.ml",
        "settings.json",
        "config.yaml",
        "query.sql",
        "Dockerfile",
      ];
      for (const filename of expected) {
        fs.writeFileSync(path.join(dir, filename), "text");
      }
      fs.writeFileSync(path.join(dir, "image.png"), "binary");

      const files = collectFiles(dir, createIgnoreFilter(dir), dir);
      const relative = files.map((file) => path.relative(dir, file));

      expect(relative).toEqual(expect.arrayContaining(expected));
      expect(relative).not.toContain(".env");
      expect(relative).not.toContain("image.png");
    } finally {
      cleanup(dir);
    }
  });

  test("skips hidden directories", () => {
    const dir = makeTempDir();
    try {
      fs.mkdirSync(path.join(dir, ".hidden"));
      fs.writeFileSync(path.join(dir, ".hidden", "secret.ts"), "");
      fs.writeFileSync(path.join(dir, "visible.ts"), "");

      const ig = createIgnoreFilter(dir);
      const files = collectFiles(dir, ig, dir);

      const relative = files.map((f) =>
        path.relative(dir, f).replace(/\\/g, "/"),
      );
      expect(relative).not.toContain(".hidden/secret.ts");
      expect(relative).toContain("visible.ts");
    } finally {
      cleanup(dir);
    }
  });

  test("does not treat a special hidden filename as a directory exception", () => {
    const dir = makeTempDir();
    try {
      fs.mkdirSync(path.join(dir, ".env"));
      fs.writeFileSync(path.join(dir, ".env", "secret.ts"), "");

      const files = collectFiles(dir, createIgnoreFilter(dir), dir);
      expect(files).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  test("skips ignored directories", () => {
    const dir = makeTempDir();
    try {
      fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", "pkg", "index.ts"), "");
      fs.writeFileSync(path.join(dir, "app.ts"), "");

      const ig = createIgnoreFilter(dir);
      const files = collectFiles(dir, ig, dir);

      const relative = files.map((f) =>
        path.relative(dir, f).replace(/\\/g, "/"),
      );
      expect(relative.some((f) => f.startsWith("node_modules"))).toBe(false);
      expect(relative).toContain("app.ts");
    } finally {
      cleanup(dir);
    }
  });
});
