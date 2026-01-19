import { describe, expect, test } from "vitest";
import {
  chunkFile,
  chunkFiles,
  detectLanguage,
  shouldIndexFile,
  SUPPORTED_EXTENSIONS,
} from "@core/embeddings/chunker";

describe("detectLanguage", () => {
  test("detects TypeScript", () => {
    expect(detectLanguage("file.ts")).toBe("typescript");
    expect(detectLanguage("file.tsx")).toBe("typescript");
  });

  test("detects JavaScript", () => {
    expect(detectLanguage("file.js")).toBe("javascript");
    expect(detectLanguage("file.jsx")).toBe("javascript");
    expect(detectLanguage("file.mjs")).toBe("javascript");
  });

  test("detects Python", () => {
    expect(detectLanguage("file.py")).toBe("python");
  });

  test("detects Rust", () => {
    expect(detectLanguage("file.rs")).toBe("rust");
  });

  test("detects Go", () => {
    expect(detectLanguage("file.go")).toBe("go");
  });

  test("returns unknown for unrecognized extensions", () => {
    expect(detectLanguage("file.xyz")).toBe("unknown");
    expect(detectLanguage("noext")).toBe("unknown");
  });
});

describe("chunkFile", () => {
  const config = {
    defaultChunkSize: 100,
    defaultChunkOverlap: 20,
  };

  test("chunks a TypeScript file", async () => {
    const content = `
export function hello() {
  return "world";
}

export function goodbye() {
  return "farewell";
}
`.trim();

    const chunks = await chunkFile("/test/file.ts", content, config);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]).toHaveProperty("id");
    expect(chunks[0]).toHaveProperty("content");
    expect(chunks[0]).toHaveProperty("filePath", "/test/file.ts");
    expect(chunks[0]).toHaveProperty("language", "typescript");
    expect(chunks[0]).toHaveProperty("startLine");
    expect(chunks[0]).toHaveProperty("endLine");
  });

  test("generates unique IDs for chunks", async () => {
    const content = `
function a() {}
function b() {}
function c() {}
`.trim();

    const chunks = await chunkFile("/test/file.ts", content, config);
    const ids = chunks.map((c) => c.id);
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(ids.length);
  });

  test("handles empty content", async () => {
    const chunks = await chunkFile("/test/empty.ts", "", config);
    expect(chunks).toHaveLength(0);
  });

  test("calculates correct line numbers", async () => {
    const content = `line1
line2
line3
line4
line5`;

    const chunks = await chunkFile("/test/file.ts", content, {
      defaultChunkSize: 1000,
      defaultChunkOverlap: 0,
    });

    expect(chunks.length).toBe(1);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.endLine).toBe(5);
  });
});

describe("chunkFiles", () => {
  const config = {
    defaultChunkSize: 100,
    defaultChunkOverlap: 20,
  };

  test("chunks multiple files", async () => {
    const files = [
      { path: "/test/file1.ts", content: "function a() {}" },
      { path: "/test/file2.py", content: "def b(): pass" },
    ];

    const chunks = await chunkFiles(files, config);

    expect(chunks.length).toBeGreaterThan(0);

    const tsChunks = chunks.filter((c) => c.language === "typescript");
    const pyChunks = chunks.filter((c) => c.language === "python");

    expect(tsChunks.length).toBeGreaterThan(0);
    expect(pyChunks.length).toBeGreaterThan(0);
  });
});

describe("shouldIndexFile", () => {
  test("returns true for supported extensions", () => {
    expect(shouldIndexFile("file.ts")).toBe(true);
    expect(shouldIndexFile("file.tsx")).toBe(true);
    expect(shouldIndexFile("file.js")).toBe(true);
    expect(shouldIndexFile("file.py")).toBe(true);
    expect(shouldIndexFile("file.rs")).toBe(true);
    expect(shouldIndexFile("file.go")).toBe(true);
    expect(shouldIndexFile("file.md")).toBe(true);
  });

  test("returns false for unsupported extensions", () => {
    expect(shouldIndexFile("file.png")).toBe(false);
    expect(shouldIndexFile("file.exe")).toBe(false);
    expect(shouldIndexFile("file.zip")).toBe(false);
    expect(shouldIndexFile(".gitignore")).toBe(false);
  });

  test("handles case insensitivity", () => {
    expect(shouldIndexFile("file.TS")).toBe(true);
    expect(shouldIndexFile("file.PY")).toBe(true);
  });
});

describe("SUPPORTED_EXTENSIONS", () => {
  test("includes common programming languages", () => {
    expect(SUPPORTED_EXTENSIONS).toContain(".ts");
    expect(SUPPORTED_EXTENSIONS).toContain(".tsx");
    expect(SUPPORTED_EXTENSIONS).toContain(".js");
    expect(SUPPORTED_EXTENSIONS).toContain(".py");
    expect(SUPPORTED_EXTENSIONS).toContain(".rs");
    expect(SUPPORTED_EXTENSIONS).toContain(".go");
    expect(SUPPORTED_EXTENSIONS).toContain(".java");
  });
});
