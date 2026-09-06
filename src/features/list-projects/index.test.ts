import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { execute, listProjectsFeature } from "@features/list-projects";

describe("list_projects feature", () => {
  const directories: string[] = [];
  const originalRoots = process.env.SRC_ALLOWED_ROOTS;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalRoots === undefined) {
      delete process.env.SRC_ALLOWED_ROOTS;
    } else {
      process.env.SRC_ALLOWED_ROOTS = originalRoots;
    }
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("lists multiple configured roots and index availability", async () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), "src-project-a-"));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "src-project-b-"));
    directories.push(first, second);
    vi.stubEnv("SRC_ALLOWED_ROOTS", `${first};${second}`);

    const result = await execute({ includeCurrent: false });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      configuredRoots: 2,
      projects: [
        { path: first, source: "SRC_ALLOWED_ROOTS", exists: true },
        { path: second, source: "SRC_ALLOWED_ROOTS", exists: true },
      ],
    });
  });

  test("keeps an invalid configured root visible instead of widening access", async () => {
    const missing = path.join(os.tmpdir(), "src-missing-root-never-created");
    vi.stubEnv("SRC_ALLOWED_ROOTS", missing);

    const result = await execute({ includeCurrent: false });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      configuredRoots: 1,
      projects: [{ path: missing, exists: false, error: "Path not found" }],
    });
  });

  test("does not fall back to the current directory for a malformed allow-list", async () => {
    vi.stubEnv("SRC_ALLOWED_ROOTS", ";,");

    const result = await execute({ includeCurrent: true });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      configuredRoots: 0,
      allowListConfigured: true,
      projects: [],
    });
  });

  test("declares a read-only feature", () => {
    expect(listProjectsFeature.annotations?.readOnlyHint).toBe(true);
  });
});
