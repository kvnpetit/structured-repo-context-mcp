import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],

    // Strict test behavior (not blocking)
    passWithNoTests: false,
    testTimeout: 10000,
    hookTimeout: 10000,
    slowTestThreshold: 1000,

    // Mock handling (clean isolation)
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      enabled: false,
      reporter: ["text", "json", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "node_modules/**",
        "dist/**",
        "src/**/*.test.ts",
        "src/**/*.config.*",
        "src/types/**",
        "src/**/types.ts",
        // Entry points (bootstrap code, not unit-testable)
        "src/bin.ts", // CLI entry: just calls runCLI()
        "src/index.ts", // MCP entry: just calls startServer()
        // Barrel exports (re-export files with no logic)
        "src/*/index.ts", // Top-level: utils, tools, prompts, cli, config, resources, features
        "src/*/utils/index.ts", // Utils subfolders: core/utils, features/utils
        "src/core/embeddings/index.ts", // Embeddings barrel export
        // Optional local subprocess/protocol adapters. Their executable- and
        // wire-level failure matrix is validated by integration/safe-degradation
        // tests rather than by the aggregate unit-coverage gate.
        "src/core/navigation/lsp.ts",
        "src/core/navigation/lsp/client.ts",
        "src/core/navigation/lsp/request.ts",
        "src/core/navigation/lsp/servers.ts",
        "src/core/navigation/lsp/sessions.ts",
        "src/features/static-analysis/index.ts",
        "src/features/static-analysis/parsers.ts",
        "src/features/static-analysis/process.ts",
        "src/public.ts", // Public package entrypoint: export-only bootstrap
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        // Keep branch coverage honest while optional external adapters remain
        // integration-tested outside the unit coverage aggregate.
        branches: 70,
        statements: 80,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@core": path.resolve(import.meta.dirname, "./src/core"),
      "@features": path.resolve(import.meta.dirname, "./src/features"),
      "@tools": path.resolve(import.meta.dirname, "./src/tools"),
      "@resources": path.resolve(import.meta.dirname, "./src/resources"),
      "@prompts": path.resolve(import.meta.dirname, "./src/prompts"),
      "@cli": path.resolve(import.meta.dirname, "./src/cli"),
      "@config": path.resolve(import.meta.dirname, "./src/config"),
      "@types": path.resolve(import.meta.dirname, "./src/types"),
      "@utils": path.resolve(import.meta.dirname, "./src/utils"),
    },
  },
});
