import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execute, getCallGraphSchema } from "@features/get-call-graph";
import * as embeddings from "@core/embeddings";

// Mock the entire embeddings module
vi.mock("@core/embeddings", () => ({
  shouldIndexFile: vi.fn(),
  buildCallGraph: vi.fn(),
  getCallContext: vi.fn(),
  formatCallContext: vi.fn(),
}));

describe("getCallGraphSchema", () => {
  test("applies default directory", () => {
    const result = getCallGraphSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.directory).toBe(".");
    }
  });

  test("validates valid input", () => {
    const result = getCallGraphSchema.safeParse({
      directory: "/test/dir",
      functionName: "myFunction",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.directory).toBe("/test/dir");
      expect(result.data.functionName).toBe("myFunction");
    }
  });

  test("validates optional fields", () => {
    const result = getCallGraphSchema.safeParse({
      directory: "/test/dir",
      functionName: "testFn",
      filePath: "src/test.ts",
      maxDepth: 5,
      exclude: ["*.test.ts"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxDepth).toBe(5);
      expect(result.data.exclude).toEqual(["*.test.ts"]);
    }
  });

  test("applies defaults", () => {
    const result = getCallGraphSchema.safeParse({
      directory: "/test/dir",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxDepth).toBe(2);
      expect(result.data.maxNodes).toBe(200);
      expect(result.data.maxFiles).toBe(500);
      expect(result.data.exclude).toEqual([]);
    }
  });

  test("validates maxDepth is positive integer", () => {
    const result = getCallGraphSchema.safeParse({
      directory: "/test/dir",
      maxDepth: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("execute", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "call-graph-test-"));
    vi.clearAllMocks();

    (embeddings.shouldIndexFile as Mock).mockReturnValue(true);

    (embeddings.buildCallGraph as Mock).mockResolvedValue({
      nodes: new Map([
        [
          "/test/file.ts:testFunction",
          {
            name: "testFunction",
            qualifiedName: "/test/file.ts:testFunction",
            filePath: "/test/file.ts",
            type: "function",
            start: { line: 1, column: 0, offset: 0 },
            end: { line: 10, column: 1, offset: 100 },
            calls: ["/test/file.ts:helperFunction"],
            calledBy: [],
          },
        ],
        [
          "/test/file.ts:helperFunction",
          {
            name: "helperFunction",
            qualifiedName: "/test/file.ts:helperFunction",
            filePath: "/test/file.ts",
            type: "function",
            start: { line: 12, column: 0, offset: 110 },
            end: { line: 20, column: 1, offset: 200 },
            calls: [],
            calledBy: ["/test/file.ts:testFunction"],
          },
        ],
      ]),
      files: ["/test/file.ts"],
      edgeCount: 1,
    });

    (embeddings.getCallContext as Mock).mockReturnValue({
      callers: [],
      callees: [
        {
          name: "helperFunction",
          qualifiedName: "/test/file.ts:helperFunction",
          filePath: "/test/file.ts",
          type: "function",
          start: { line: 12, column: 0, offset: 110 },
          end: { line: 20, column: 1, offset: 200 },
          calls: [],
          calledBy: ["/test/file.ts:testFunction"],
        },
      ],
    });

    (embeddings.formatCallContext as Mock).mockReturnValue("Calls: helperFunction");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test("returns error for non-existent directory", async () => {
    const result = await execute({
      directory: "/non/existent/directory",
      maxDepth: 2,
      exclude: [],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Directory not found");
  });

  test("returns success with no files when directory is empty", async () => {
    (embeddings.shouldIndexFile as Mock).mockReturnValue(false);

    const result = await execute({
      directory: tempDir,
      maxDepth: 2,
      exclude: [],
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("No analyzable files");
  });

  test("builds full call graph for directory", async () => {
    // Create a test file
    const testFile = path.join(tempDir, "test.ts");
    fs.writeFileSync(
      testFile,
      `
function testFunction() {
  helperFunction();
}

function helperFunction() {
  return 1;
}
`,
    );

    const result = await execute({
      directory: tempDir,
      maxDepth: 2,
      exclude: [],
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("Call graph analysis complete");
    expect(embeddings.buildCallGraph).toHaveBeenCalled();
  });

  test("bounds files analyzed and reports file truncation", async () => {
    fs.writeFileSync(path.join(tempDir, "a.ts"), "function a() {}");
    fs.writeFileSync(path.join(tempDir, "b.ts"), "function b() {}");

    const result = await execute({
      directory: tempDir,
      maxFiles: 1,
      exclude: [],
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      filesAnalyzed: 1,
      filesTruncated: true,
      truncated: true,
    });
    expect(embeddings.buildCallGraph).toHaveBeenCalledWith([
      expect.objectContaining({ path: path.join(tempDir, "a.ts") }),
    ]);
  });

  test("bounds full graph output and reports truncation", async () => {
    const testFile = path.join(tempDir, "test.ts");
    fs.writeFileSync(testFile, "function test() {}");

    const nodes = new Map<string, unknown>();
    for (const name of ["alpha", "beta", "gamma"]) {
      nodes.set(`${testFile}:${name}`, {
        name,
        qualifiedName: `${testFile}:${name}`,
        filePath: testFile,
        type: "function",
        start: { line: 1, column: 0, offset: 0 },
        end: { line: 1, column: 18, offset: 18 },
        calls: name === "alpha" ? [`${testFile}:beta`] : [],
        calledBy: name === "beta" ? [`${testFile}:alpha`] : [],
      });
    }
    (embeddings.buildCallGraph as Mock).mockResolvedValue({
      nodes,
      files: [testFile],
      edgeCount: 1,
    });

    const result = await execute({
      directory: tempDir,
      maxDepth: 2,
      maxNodes: 2,
      exclude: [],
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      truncated: true,
      maxNodes: 2,
    });
    expect(Object.keys((result.data as { graph: { nodes: object } }).graph.nodes)).toHaveLength(2);
  });

  test("queries specific function when functionName is provided", async () => {
    // Create a test file
    const testFile = path.join(tempDir, "test.ts");
    fs.writeFileSync(testFile, "function test() {}");

    const result = await execute({
      directory: tempDir,
      functionName: "testFunction",
      maxDepth: 2,
      exclude: [],
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("testFunction");
  });

  test("returns error when function not found", async () => {
    const testFile = path.join(tempDir, "test.ts");
    fs.writeFileSync(testFile, "function test() {}");

    (embeddings.getCallContext as Mock).mockReturnValue(null);
    (embeddings.buildCallGraph as Mock).mockResolvedValue({
      nodes: new Map(),
      files: [testFile],
      edgeCount: 0,
    });

    const result = await execute({
      directory: tempDir,
      functionName: "nonExistentFunction",
      maxDepth: 2,
      exclude: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("handles errors during call graph building", async () => {
    const testFile = path.join(tempDir, "test.ts");
    fs.writeFileSync(testFile, "function test() {}");

    (embeddings.buildCallGraph as Mock).mockRejectedValue(new Error("Parse error"));

    const result = await execute({
      directory: tempDir,
      maxDepth: 2,
      exclude: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Parse error");
  });

  test("handles non-Error exceptions", async () => {
    const testFile = path.join(tempDir, "test.ts");
    fs.writeFileSync(testFile, "function test() {}");

    (embeddings.buildCallGraph as Mock).mockRejectedValue("String error");

    const result = await execute({
      directory: tempDir,
      maxDepth: 2,
      exclude: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("String error");
  });

  test("uses filePath to narrow function search", async () => {
    const testFile = path.join(tempDir, "test.ts");
    fs.writeFileSync(testFile, "function test() {}");

    const result = await execute({
      directory: tempDir,
      functionName: "testFunction",
      filePath: "test.ts",
      maxDepth: 2,
      exclude: [],
    });

    expect(result.success).toBe(true);
  });

  test("finds function in any file when not found in specified path", async () => {
    const testFile = path.join(tempDir, "test.ts");
    fs.writeFileSync(testFile, "function test() {}");

    // First call returns null (not found in specified path)
    // Second call finds it in the graph
    (embeddings.getCallContext as Mock).mockReturnValueOnce(null).mockReturnValue({
      callers: [],
      callees: [],
    });

    (embeddings.buildCallGraph as Mock).mockResolvedValue({
      nodes: new Map([
        [
          `${testFile}:testFunction`,
          {
            name: "testFunction",
            qualifiedName: `${testFile}:testFunction`,
            filePath: testFile,
            type: "function",
            start: { line: 1, column: 0, offset: 0 },
            end: { line: 5, column: 1, offset: 50 },
            calls: [],
            calledBy: [],
          },
        ],
      ]),
      files: [testFile],
      edgeCount: 0,
    });

    const result = await execute({
      directory: tempDir,
      functionName: "testFunction",
      filePath: "other.ts",
      maxDepth: 2,
      exclude: [],
    });

    expect(result.success).toBe(true);
  });

  test("excludes patterns from analysis", async () => {
    const testFile = path.join(tempDir, "test.ts");
    const excludedFile = path.join(tempDir, "test.spec.ts");
    fs.writeFileSync(testFile, "function test() {}");
    fs.writeFileSync(excludedFile, "function spec() {}");

    // Make shouldIndexFile return false for spec files based on the name
    (embeddings.shouldIndexFile as Mock).mockImplementation(
      (name: string) => !name.includes(".spec."),
    );

    const result = await execute({
      directory: tempDir,
      exclude: ["*.spec.ts"],
      maxDepth: 2,
    });

    expect(result.success).toBe(true);
  });
});
