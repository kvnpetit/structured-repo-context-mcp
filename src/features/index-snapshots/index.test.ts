import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { execute, indexSnapshotsSchema } from "@features/index-snapshots";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("manage_index_snapshots", () => {
  test("validates bounded operation defaults", () => {
    const parsed = indexSnapshotsSchema.safeParse({ operation: "list" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.max_snapshot_bytes).toBe(500 * 1024 * 1024);
      expect(parsed.data.list_limit).toBe(50);
    }
  });

  test("creates, lists, verifies, and restores a local snapshot", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-snapshot-"));
    directories.push(directory);
    const indexDirectory = path.join(directory, ".src-index");
    fs.mkdirSync(path.join(indexDirectory, "code_chunks.lance"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(indexDirectory, "metadata.json"), '{"schemaVersion":1}');
    fs.writeFileSync(path.join(indexDirectory, "code_chunks.lance", "data.bin"), "original-index");

    const snapshot = await execute({ operation: "snapshot", directory });
    expect(snapshot.success).toBe(true);
    if (!snapshot.success) {
      return;
    }
    const snapshotData = snapshot.data as {
      snapshot_id?: string;
      snapshots: unknown[];
    };
    expect(snapshotData.snapshot_id).toMatch(/^snapshot-/u);
    expect(snapshotData.snapshots).toHaveLength(1);
    const id = snapshotData.snapshot_id;
    if (id === undefined) {
      return;
    }

    fs.writeFileSync(path.join(indexDirectory, "code_chunks.lance", "data.bin"), "corrupted-index");
    const restored = await execute({
      operation: "restore",
      directory,
      snapshot_id: id,
      backup_current: false,
    });
    expect(restored.success).toBe(true);
    expect(
      fs.readFileSync(path.join(indexDirectory, "code_chunks.lance", "data.bin"), "utf8"),
    ).toBe("original-index");

    const listed = await execute({ operation: "list", directory });
    expect(listed.success).toBe(true);
    if (listed.success) {
      expect((listed.data as { snapshots: { valid: boolean }[] }).snapshots[0]?.valid).toBe(true);
    }
  });

  test("rejects corrupt snapshot content before restore", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-snapshot-"));
    directories.push(directory);
    fs.mkdirSync(path.join(directory, ".src-index"), { recursive: true });
    fs.writeFileSync(path.join(directory, ".src-index", "metadata.json"), "metadata");
    const snapshot = await execute({ operation: "snapshot", directory });
    expect(snapshot.success).toBe(true);
    if (!snapshot.success) {
      return;
    }
    const id = (snapshot.data as { snapshot_id: string }).snapshot_id;
    const payload = path.join(directory, ".src-index-snapshots", id, "payload", "metadata.json");
    fs.writeFileSync(payload, "tampered");
    const result = await execute({
      operation: "restore",
      directory,
      snapshot_id: id,
      backup_current: false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("verification failed");
    expect(fs.readFileSync(path.join(directory, ".src-index", "metadata.json"), "utf8")).toBe(
      "metadata",
    );
  });
});
