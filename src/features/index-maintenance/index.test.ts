import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { EMBEDDING_CONFIG } from "@config";
import { VectorStore } from "@core/embeddings";
import { execute, indexMaintenanceSchema } from "@features/index-maintenance";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function createIndex(): Promise<string> {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "src-mcp-maintenance-"),
  );
  directories.push(directory);
  const store = new VectorStore(directory, EMBEDDING_CONFIG);
  await store.connect();
  await store.addChunks([
    {
      id: "maintenance-chunk",
      content: "export const maintenance = true;",
      filePath: path.join(directory, "module.ts"),
      language: "typescript",
      startLine: 1,
      endLine: 1,
      vector: new Array<number>(EMBEDDING_CONFIG.embeddingDimensions).fill(0),
    },
  ]);
  store.close();
  return directory;
}

describe("maintain_index", () => {
  test("validates safe defaults", () => {
    const parsed = indexMaintenanceSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.operation).toBe("inspect");
      expect(parsed.data.cleanup_older_than_days).toBe(7);
      expect(parsed.data.delete_unverified).toBe(false);
    }
  });

  test("inspects a local table without changing it", async () => {
    const directory = await createIndex();
    const result = await execute({ directory, operation: "inspect" });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data).toMatchObject({
      operation: "inspect",
      index_present: true,
      changed: false,
      before: {
        table_present: true,
        rows: 1,
        metadata_compatible: true,
      },
      manifest_paths_v2_migrated: false,
    });
  });

  test("runs bounded local compaction and manifest migration", async () => {
    const directory = await createIndex();
    const compacted = await execute({
      directory,
      operation: "compact",
      cleanup_older_than_days: 7,
    });
    expect(compacted.success).toBe(true);
    if (!compacted.success) {
      return;
    }
    const compactedData = compacted.data as {
      operation: string;
      index_present: boolean;
      optimization?: { compaction: object; prune: object };
    };
    expect(compactedData.operation).toBe("compact");
    expect(compactedData.index_present).toBe(true);
    expect(compactedData.optimization).toBeDefined();
    expect(compactedData.optimization?.compaction).toBeDefined();
    expect(compactedData.optimization?.prune).toBeDefined();

    const migrated = await execute({ directory, operation: "migrate" });
    expect(migrated.success).toBe(true);
    if (!migrated.success) {
      return;
    }
    const migratedData = migrated.data as {
      operation: string;
      index_present: boolean;
      manifest_paths_v2_migrated: boolean;
    };
    expect(migratedData.operation).toBe("migrate");
    expect(migratedData.index_present).toBe(true);
    expect(typeof migratedData.manifest_paths_v2_migrated).toBe("boolean");
  });

  test("reports a missing index without creating one for inspection", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "src-mcp-maintenance-empty-"),
    );
    directories.push(directory);

    const result = await execute({ directory, operation: "inspect" });

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(directory, ".src-index"))).toBe(false);
    if (result.success) {
      expect(result.data).toMatchObject({
        index_present: false,
        before: { table_present: false },
      });
    }
  });
});
