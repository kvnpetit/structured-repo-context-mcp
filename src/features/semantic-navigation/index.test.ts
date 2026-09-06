import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  execute,
  semanticNavigationFeature,
  semanticNavigationSchema,
} from "@features/semantic-navigation";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createProject(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "src-mcp-semantic-navigation-"),
  );
  temporaryDirectories.push(directory);
  fs.writeFileSync(
    path.join(directory, "module.ts"),
    [
      "export function target(value: number): number {",
      "  return value + 1;",
      "}",
      "",
      "export function caller(): number {",
      "  return target(41);",
      "}",
      "",
    ].join("\n"),
  );
  return directory;
}

describe("semantic_navigation", () => {
  test("validates safe defaults and bounded operations", () => {
    const result = semanticNavigationSchema.safeParse({
      file_path: "module.ts",
      line: 1,
      column: 16,
      operation: "definition",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backend).toBe("auto");
      expect(result.data.max_results).toBe(50);
      expect(result.data.include_source).toBe(true);
      expect(result.data.redact_secrets).toBe(true);
    }
  });

  test("accepts diagnostics and type hierarchy operations", () => {
    for (const operation of ["diagnostics", "type_hierarchy"] as const) {
      expect(
        semanticNavigationSchema.safeParse({
          file_path: "module.ts",
          line: 1,
          column: 0,
          operation,
        }).success,
      ).toBe(true);
    }
  });

  test("uses the explicit Tree-sitter fallback for definitions and references", async () => {
    const directory = createProject();

    const definition = await execute({
      directory,
      file_path: "module.ts",
      line: 1,
      column: 16,
      operation: "definition",
      backend: "treesitter",
    });
    expect(definition.success).toBe(true);
    if (!definition.success) {
      return;
    }
    const definitionData = definition.data as {
      backend_used: string;
      coverage: string;
      confidence: number;
      locations: {
        file_path: string;
        start: { line: number };
        snippet?: string;
      }[];
      warnings: string[];
    };
    expect(definitionData.backend_used).toBe("treesitter");
    expect(definitionData.coverage).toBe("approximate");
    expect(definitionData.confidence).toBeGreaterThan(0);
    const definitionLocation = definitionData.locations.find(
      (location) =>
        location.file_path === "module.ts" && location.start.line === 1,
    );
    expect(definitionLocation).toBeDefined();
    expect(definitionLocation?.snippet).toContain("function target");
    expect(definitionData.warnings.join(" ")).toContain("syntax/text");

    const references = await execute({
      directory,
      file_path: "module.ts",
      line: 6,
      column: 9,
      operation: "references",
      backend: "treesitter",
    });
    expect(references.success).toBe(true);
    if (!references.success) {
      return;
    }
    const referenceData = references.data as {
      locations: { file_path: string; start: { line: number } }[];
    };
    expect(
      referenceData.locations.some(
        (location) =>
          location.file_path === "module.ts" && location.start.line === 6,
      ),
    ).toBe(true);
  });

  test("does not fabricate implementations without an LSP", async () => {
    const directory = createProject();
    const result = await execute({
      directory,
      file_path: "module.ts",
      line: 1,
      column: 16,
      operation: "implementation",
      backend: "treesitter",
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data).toMatchObject({
      backend_used: "treesitter",
      coverage: "unavailable",
      locations: [],
    });
  });

  test("reports approximate syntax diagnostics with the Tree-sitter backend", async () => {
    const directory = createProject();
    fs.writeFileSync(
      path.join(directory, "broken.ts"),
      "export function broken( {\n",
    );
    const result = await execute({
      directory,
      file_path: "broken.ts",
      line: 1,
      column: 20,
      operation: "diagnostics",
      backend: "treesitter",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        backend_used: "treesitter",
        coverage: "approximate",
      });
      expect(
        (result.data as { diagnostics: { severity?: string }[] }).diagnostics
          .length,
      ).toBeGreaterThan(0);
    }
  });

  test("does not fabricate type hierarchy results without an LSP", async () => {
    const directory = createProject();
    const result = await execute({
      directory,
      file_path: "module.ts",
      line: 1,
      column: 16,
      operation: "type_hierarchy",
      backend: "treesitter",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        coverage: "unavailable",
        locations: [],
      });
    }
  });

  test("falls back explicitly when local LSP is disabled", async () => {
    vi.stubEnv("SRC_LSP_ENABLED", "false");
    const directory = createProject();
    const result = await execute({
      directory,
      file_path: "module.ts",
      line: 1,
      column: 16,
      operation: "hover",
      backend: "auto",
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data).toMatchObject({
      backend_used: "treesitter",
      coverage: "approximate",
    });
    expect(
      (result.data as { warnings: string[] }).warnings.join(" "),
    ).toContain("LSP unavailable");
  });

  test("returns an explicit error when LSP is required but disabled", async () => {
    vi.stubEnv("SRC_LSP_ENABLED", "false");
    const directory = createProject();
    const result = await execute({
      directory,
      file_path: "module.ts",
      line: 1,
      column: 16,
      operation: "definition",
      backend: "lsp",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Local LSP navigation failed");
  });

  test("declares read-only local behavior", () => {
    expect(semanticNavigationFeature.annotations?.readOnlyHint).toBe(true);
    expect(semanticNavigationFeature.description).toContain("local");
  });
});
