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
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@features": path.resolve(__dirname, "./src/features"),
      "@tools": path.resolve(__dirname, "./src/tools"),
      "@resources": path.resolve(__dirname, "./src/resources"),
      "@prompts": path.resolve(__dirname, "./src/prompts"),
      "@cli": path.resolve(__dirname, "./src/cli"),
      "@config": path.resolve(__dirname, "./src/config"),
      "@types": path.resolve(__dirname, "./src/types"),
      "@utils": path.resolve(__dirname, "./src/utils"),
    },
  },
});
