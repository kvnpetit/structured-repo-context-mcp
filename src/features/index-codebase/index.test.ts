import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execute, indexCodebaseSchema } from "@features/index-codebase";

// Mock the entire embeddings module
vi.mock("@core/embeddings", () => ({
  createOllamaClient: vi.fn().mockImplementation(() => ({
    healthCheck: vi.fn().mockResolvedValue({ ok: true }),
    embedBatch: vi
      .fn()
      .mockImplementation(async (texts: string[]) =>
        Promise.resolve(
          texts.map(() => new Array(768).fill(0).map(() => Math.random())),
        ),
      ),
  })),
  createVectorStore: vi.fn().mockImplementation(() => ({
    exists: vi.fn().mockReturnValue(false),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    addChunks: vi.fn().mockResolvedValue(undefined),
  })),
  chunkFile: vi
    .fn()
    .mockImplementation(async (filePath: string, content: string) =>
      Promise.resolve([
        {
          id: "chunk_1",
          content,
          filePath,
          language: "typescript",
          startLine: 1,
          endLine: 1,
        },
      ]),
    ),
  shouldIndexFile: vi
    .fn()
    .mockImplementation(
      (filePath: string) =>
        filePath.endsWith(".ts") || filePath.endsWith(".js"),
    ),
}));

describe("indexCodebaseSchema", () => {
  test("applies default directory", () => {
    const result = indexCodebaseSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.directory).toBe(".");
    }
  });

  test("validates valid input", () => {
    const result = indexCodebaseSchema.safeParse({
      directory: "/test/dir",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.directory).toBe("/test/dir");
    }
  });

  test("validates optional fields", () => {
    const result = indexCodebaseSchema.safeParse({
      directory: "/test/dir",
      force: true,
      exclude: ["*.log"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.force).toBe(true);
      expect(result.data.exclude).toEqual(["*.log"]);
    }
  });

  test("applies defaults", () => {
    const result = indexCodebaseSchema.safeParse({
      directory: "/test/dir",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.force).toBe(false);
      expect(result.data.exclude).toEqual([]);
    }
  });
});

describe("execute", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "index-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns error for non-existent directory", async () => {
    const result = await execute({
      directory: "/nonexistent/path",
      force: false,
      exclude: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Directory not found");
  });

  test("returns message for empty directory", async () => {
    const result = await execute({
      directory: tempDir,
      force: false,
      exclude: [],
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("No indexable files found");
  });

  test("indexes TypeScript files", async () => {
    // Create test files
    fs.writeFileSync(
      path.join(tempDir, "test.ts"),
      'export function hello() { return "world"; }',
    );

    const result = await execute({
      directory: tempDir,
      force: false,
      exclude: [],
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("filesIndexed", 1);
    expect(result.data).toHaveProperty("chunksCreated");
  });

  test("excludes specified patterns", async () => {
    // Create files
    fs.writeFileSync(path.join(tempDir, "included.ts"), "export const x = 1;");
    fs.mkdirSync(path.join(tempDir, "excluded"));
    fs.writeFileSync(
      path.join(tempDir, "excluded", "skip.ts"),
      "export const y = 2;",
    );

    const result = await execute({
      directory: tempDir,
      force: false,
      exclude: ["excluded"],
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("filesIndexed", 1);
  });

  test("excludes patterns from .gitignore", async () => {
    // Create .gitignore with node_modules
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "node_modules\n");

    // Create files
    fs.writeFileSync(path.join(tempDir, "main.ts"), 'import x from "pkg";');
    fs.mkdirSync(path.join(tempDir, "node_modules"));
    fs.writeFileSync(
      path.join(tempDir, "node_modules", "pkg.ts"),
      "export default 1;",
    );

    const result = await execute({
      directory: tempDir,
      force: false,
      exclude: [],
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("filesIndexed", 1);
  });

  test("excludes hidden folders starting with dot", async () => {
    // Create files
    fs.writeFileSync(path.join(tempDir, "main.ts"), "export const x = 1;");
    fs.mkdirSync(path.join(tempDir, ".hidden"));
    fs.writeFileSync(
      path.join(tempDir, ".hidden", "secret.ts"),
      "export default 1;",
    );

    const result = await execute({
      directory: tempDir,
      force: false,
      exclude: [],
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("filesIndexed", 1);
  });
});
