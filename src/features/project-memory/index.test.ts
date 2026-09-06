import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

import {
  executeGetProjectMemory,
  executeSetProjectMemory,
  getProjectMemoryOutputSchema,
  getProjectMemorySchema,
  setProjectMemorySchema,
} from "@features/project-memory";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-memory-"));
  directories.push(directory);
  return directory;
}

describe("project memory", () => {
  test("validates bounded defaults", () => {
    const parsed = getProjectMemorySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.limit).toBe(50);
      expect(parsed.data.include_expired).toBe(false);
      expect(parsed.data.redact_secrets).toBe(true);
      expect(parsed.data.scope).toBe("project");
      expect(parsed.data.search_mode).toBe("hybrid");
    }
  });

  test("creates, searches, updates, and deletes an isolated record", async () => {
    const directory = makeDirectory();
    const created = await executeSetProjectMemory({
      directory,
      operation: "upsert",
      id: "auth-decision",
      kind: "decision",
      title: "Authentication boundary",
      body: "Keep tokens in the server boundary; apiKey: super-secret-value",
      tags: ["Security", "auth", "auth"],
      links: [{ kind: "references", target: "docs/security.md" }],
    });
    expect(created.success).toBe(true);
    if (!created.success) {
      return;
    }
    const createdData = created.data as {
      record: { body: string; tags: string[]; updated_at: string };
      store_revision: string;
    };
    expect(createdData.record.body).not.toContain("super-secret-value");
    expect(createdData.record.tags).toEqual(["security", "auth"]);
    expect(createdData.store_revision).toMatch(/^[a-f0-9]{64}$/u);

    const found = await executeGetProjectMemory({
      directory,
      query: "authentication",
    });
    expect(found.success).toBe(true);
    if (!found.success) {
      return;
    }
    const foundData = found.data as {
      records: { id: string; body: string }[];
      state: string;
      secrets_redacted: boolean;
    };
    expect(foundData.state).toBe("ready");
    expect(foundData.records[0]?.id).toBe("auth-decision");
    expect(foundData.records[0]?.body).not.toContain("super-secret-value");
    expect(foundData.secrets_redacted).toBe(false);
    expect(
      getProjectMemoryOutputSchema.safeParse({
        schema_version: 1,
        success: true,
        meta: {
          generated_at: new Date().toISOString(),
          local_only: true,
          bounded: true,
          provenance: "local-filesystem",
          index_freshness: "unknown",
        },
        data: found.data,
        message: found.message,
      }).success,
    ).toBe(true);

    const updated = await executeSetProjectMemory({
      directory,
      operation: "upsert",
      id: "auth-decision",
      kind: "constraint",
      title: "Authentication boundary",
      body: "Tokens stay server-side",
      expected_updated_at: new Date(0).toISOString(),
    });
    expect(updated.success).toBe(false);
    expect(updated.error).toContain("expected_updated_at");

    const deleted = await executeSetProjectMemory({
      directory,
      operation: "delete",
      id: "auth-decision",
    });
    expect(deleted.success).toBe(true);
    const empty = await executeGetProjectMemory({ directory });
    expect(empty.success).toBe(true);
    if (empty.success) {
      expect((empty.data as { records: unknown[] }).records).toHaveLength(0);
    }
  });

  test("supports stateless pagination and rejects a cursor from another query", async () => {
    const directory = makeDirectory();
    for (const id of ["one", "two", "three"]) {
      await executeSetProjectMemory({
        directory,
        operation: "upsert",
        id,
        kind: "note",
        title: id,
        body: "bounded note",
      });
    }
    const first = await executeGetProjectMemory({ directory, limit: 2 });
    expect(first.success).toBe(true);
    if (!first.success) {
      return;
    }
    const firstData = first.data as {
      records: { id: string }[];
      next_cursor?: string;
    };
    expect(firstData.records).toHaveLength(2);
    expect(firstData.next_cursor).toBeDefined();

    const second = await executeGetProjectMemory({
      directory,
      limit: 2,
      cursor: firstData.next_cursor,
    });
    expect(second.success).toBe(true);
    if (second.success) {
      expect(
        (second.data as { records: { id: string }[] }).records,
      ).toHaveLength(1);
    }

    const mismatch = await executeGetProjectMemory({
      directory,
      query: "other",
      limit: 2,
      cursor: firstData.next_cursor,
    });
    expect(mismatch.success).toBe(false);
    expect(mismatch.error).toContain("does not match");
  });

  test("returns a safe missing state and detects a corrupt state", async () => {
    const directory = makeDirectory();
    const missing = await executeGetProjectMemory({ directory });
    expect(missing.success).toBe(true);
    if (missing.success) {
      expect((missing.data as { state: string }).state).toBe("missing");
    }
    fs.mkdirSync(path.join(directory, ".src-index"));
    fs.writeFileSync(
      path.join(directory, ".src-index", "project-memory.json"),
      "not-json",
    );
    const corrupt = await executeGetProjectMemory({ directory });
    expect(corrupt.success).toBe(false);
    expect(corrupt.error).toContain("corrupt");
  });

  test("keeps records isolated by local scope, including duplicate IDs", async () => {
    const directory = makeDirectory();
    for (const scope of ["project", "release"]) {
      const created = await executeSetProjectMemory({
        directory,
        scope,
        operation: "upsert",
        id: "same-id",
        kind: "note",
        title: `${scope} decision`,
        body: "scope-specific context",
      });
      expect(created.success).toBe(true);
    }

    const release = await executeGetProjectMemory({
      directory,
      scope: "release",
      query: "release decision",
    });
    expect(release.success).toBe(true);
    if (release.success) {
      expect(release.data).toMatchObject({
        scope: "release",
        records_total: 1,
        records: [{ id: "same-id", scope: "release" }],
      });
    }

    const deleted = await executeSetProjectMemory({
      directory,
      scope: "project",
      operation: "delete",
      id: "same-id",
    });
    expect(deleted.success).toBe(true);
    const remaining = await executeGetProjectMemory({
      directory,
      scope: "release",
    });
    expect(remaining.success).toBe(true);
    if (remaining.success) {
      const remainingData = remaining.data as { records: unknown[] };
      expect(remainingData.records).toHaveLength(1);
    }
  });

  test("captures local Git provenance and marks memories stale after HEAD changes", async () => {
    const directory = makeDirectory();
    execFileSync("git", ["init"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "tests@example.invalid"], {
      cwd: directory,
    });
    execFileSync("git", ["config", "user.name", "SRC tests"], {
      cwd: directory,
    });
    fs.writeFileSync(path.join(directory, "tracked.txt"), "one\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: directory });
    execFileSync("git", ["commit", "-m", "first"], { cwd: directory });

    const created = await executeSetProjectMemory({
      directory,
      operation: "upsert",
      id: "architecture",
      kind: "decision",
      title: "Architecture",
      body: "Use the local index",
      confidence: 0.9,
    });
    expect(created.success).toBe(true);
    if (!created.success) {
      return;
    }
    const captured = created.data as { record: { source_revision?: string } };
    expect(captured.record.source_revision).toMatch(/^[a-f0-9]{40}$/u);

    const symbolic = await executeSetProjectMemory({
      directory,
      operation: "upsert",
      id: "symbolic-revision",
      kind: "fact",
      title: "Symbolic revision",
      body: "Created from HEAD",
      source_revision: "HEAD",
    });
    expect(symbolic.success).toBe(true);
    if (symbolic.success) {
      expect(symbolic.data).toMatchObject({
        record: { source_revision: captured.record.source_revision },
      });
    }

    const current = await executeGetProjectMemory({ directory });
    expect(current.success).toBe(true);
    if (current.success) {
      expect(current.data).toMatchObject({
        revision_summary: { current: 2, stale: 0, unknown: 0 },
      });
    }

    fs.writeFileSync(path.join(directory, "tracked.txt"), "two\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: directory });
    execFileSync("git", ["commit", "-m", "second"], { cwd: directory });
    const stale = await executeGetProjectMemory({ directory });
    expect(stale.success).toBe(true);
    if (stale.success) {
      expect(stale.data).toMatchObject({
        revision_summary: { current: 0, stale: 2, unknown: 0 },
      });
    }
  });

  test("filters low-confidence memories and rejects invalid expiry dates", async () => {
    const directory = makeDirectory();
    await executeSetProjectMemory({
      directory,
      operation: "upsert",
      id: "guess",
      kind: "fact",
      title: "Uncertain guess",
      body: "May be outdated",
      confidence: 0.2,
      capture_source_revision: false,
    });
    const filtered = await executeGetProjectMemory({
      directory,
      min_confidence: 0.5,
    });
    expect(filtered.success).toBe(true);
    if (filtered.success) {
      expect(filtered.data).toMatchObject({
        records_total: 0,
        revision_summary: { current: 0, stale: 0, unknown: 0 },
      });
    }
    expect(
      setProjectMemorySchema.safeParse({
        directory,
        operation: "upsert",
        id: "bad-expiry",
        kind: "note",
        title: "Bad expiry",
        body: "invalid",
        expires_at: "not-a-date",
      }).success,
    ).toBe(false);
  });

  test("rejects malformed persisted expiry and enforces the global record limit", async () => {
    const directory = makeDirectory();
    const stateDirectory = path.join(directory, ".src-index");
    const memoryFile = path.join(stateDirectory, "project-memory.json");
    fs.mkdirSync(stateDirectory);
    const record = (id: string, scope: string, expiresAt?: string) => ({
      id,
      scope,
      kind: "note",
      title: id,
      body: "bounded",
      tags: [],
      links: [],
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
      confidence: 0.8,
    });
    fs.writeFileSync(
      memoryFile,
      JSON.stringify({
        version: 1,
        updated_at: new Date(0).toISOString(),
        records: [record("invalid-expiry", "project", "not-a-date")],
      }),
    );
    const malformed = await executeGetProjectMemory({ directory });
    expect(malformed).toMatchObject({ success: false });
    if (!malformed.success) {
      expect(malformed.error).toContain("corrupt");
    }

    fs.writeFileSync(
      memoryFile,
      JSON.stringify({
        version: 1,
        updated_at: new Date(0).toISOString(),
        records: Array.from({ length: 500 }, (_, index) =>
          record(`record-${String(index)}`, index === 0 ? "other" : "project"),
        ),
      }),
    );
    const overflow = await executeSetProjectMemory({
      directory,
      scope: "other",
      operation: "upsert",
      id: "overflow",
      kind: "note",
      title: "Overflow",
      body: "Must not be written",
      capture_source_revision: false,
    });
    expect(overflow).toMatchObject({ success: false });
    if (!overflow.success) {
      expect(overflow.error).toContain("500-record limit");
    }
  });
});
