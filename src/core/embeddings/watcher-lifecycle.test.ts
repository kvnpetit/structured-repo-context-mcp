import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { getEmbeddingConfig } from "@config";
import { LexicalEmbeddingClient } from "@core/embeddings/client";
import { readHashCache } from "@core/embeddings/hash-cache";
import { VectorStore } from "@core/embeddings/store";
import { IndexWatcher } from "@core/embeddings/watcher";

const config = getEmbeddingConfig({
  EMBEDDING_PROVIDER: "lexical",
  EMBEDDING_DIMENSIONS: "8",
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("watcher lifecycle with native LanceDB and local embeddings", () => {
  let root: string;
  const watchers: IndexWatcher[] = [];
  const releases: (() => void)[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "src-watcher-lifecycle-"));
  });

  afterEach(async () => {
    releases.splice(0).forEach((release) => {
      release();
    });
    await Promise.all(watchers.splice(0).map(async (watcher) => watcher.stop()));
    vi.restoreAllMocks();
    // root was created by this test and must remain directly inside os.tmpdir().
    if (path.dirname(root) !== path.resolve(os.tmpdir())) {
      throw new Error("Unexpected watcher test fixture path");
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(name: string, marker: string): string {
    const file = path.join(root, `${name}.ts`);
    fs.writeFileSync(file, `function ${name}() { return '${marker}'; }\n`);
    return file;
  }

  function watcher(debounceMs = 10): IndexWatcher {
    const instance = new IndexWatcher({ directory: root, config, debounceMs });
    watchers.push(instance);
    return instance;
  }

  async function indexed(): Promise<Map<string, string>> {
    const store = new VectorStore(root, config);
    await store.connect();
    try {
      const rows = await store.searchLexical("function", 100);
      return new Map(rows.map((row) => [path.basename(row.chunk.filePath), row.chunk.content]));
    } finally {
      store.close();
    }
  }

  function blockNextEmbedding(): {
    entered: Promise<void>;
    release: () => void;
  } {
    const entered = deferred();
    const blocked = deferred();
    const original = LexicalEmbeddingClient.prototype.embedBatch;
    vi.spyOn(LexicalEmbeddingClient.prototype, "embedBatch").mockImplementationOnce(async function (
      this: LexicalEmbeddingClient,
      texts: string[],
    ) {
      entered.resolve();
      await blocked.promise;
      return original.call(this, texts);
    });
    releases.push(blocked.resolve);
    return { entered: entered.promise, release: blocked.resolve };
  }

  test("reconciles edits, additions, deletions and renames made while stopped", async () => {
    const changed = write("changed", "original");
    const removed = write("removed", "original");
    const renamed = write("renamed", "original");
    write("unchanged", "original");
    const initial = watcher();
    await initial.start();
    expect((await indexed()).size).toBe(4);
    await initial.stop();

    fs.writeFileSync(changed, "function changed() { return 'updated'; }\n");
    fs.unlinkSync(removed);
    fs.renameSync(renamed, path.join(root, "moved.ts"));
    write("added", "newly added");

    const restarted = watcher();
    await restarted.start();
    const rows = await indexed();
    expect([...rows.keys()].sort()).toEqual(["added.ts", "changed.ts", "moved.ts", "unchanged.ts"]);
    expect(rows.get("changed.ts")).toContain("updated");
    expect(rows.get("added.ts")).toContain("newly added");
    const cache = readHashCache(root);
    expect(cache.valid).toBe(true);
    expect(
      Object.keys(cache.cache)
        .map((file) => path.basename(file))
        .sort(),
    ).toEqual([...rows.keys()].sort());
  });

  test("captures edits and additions while startup embeddings are pending", async () => {
    const file = write("duringStartup", "old snapshot");
    const gate = blockNextEmbedding();
    const active = watcher();
    const starting = active.start();
    await gate.entered;
    fs.writeFileSync(file, "function duringStartup() { return 'new snapshot'; }\n");
    write("addedDuringStartup", "captured during startup");
    // Allow the real chokidar awaitWriteFinish phase to observe both events.
    await new Promise((resolve) => setTimeout(resolve, 800));
    gate.release();
    await starting;
    const rows = await indexed();
    expect(rows.get("duringStartup.ts")).toContain("new snapshot");
    expect(rows.get("addedDuringStartup.ts")).toContain("captured during startup");
  });

  test("stop drains debounced edits and changes still buffered by chokidar", async () => {
    const file = write("edited", "before stop");
    const active = watcher(60_000);
    await active.start();
    fs.writeFileSync(file, "function edited() { return 'debounced change'; }\n");
    await new Promise((resolve) => setTimeout(resolve, 800));
    write("lastMoment", "not yet emitted by chokidar");
    await active.stop();
    const rows = await indexed();
    expect(rows.get("edited.ts")).toContain("debounced change");
    expect(rows.get("lastMoment.ts")).toContain("not yet emitted by chokidar");
    expect(active.isRunning()).toBe(false);
  });

  test("stop waits for an active replacement before closing the database", async () => {
    const file = write("inFlight", "before update");
    const active = watcher();
    await active.start();
    const gate = blockNextEmbedding();
    fs.writeFileSync(file, "function inFlight() { return 'update in flight'; }\n");
    await gate.entered;
    let stopped = false;
    const stopping = active.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toBe(false);
    gate.release();
    await stopping;
    expect((await indexed()).get("inFlight.ts")).toContain("update in flight");
  });

  test("reuses a stopped watcher and does not re-embed unchanged indexed files", async () => {
    write("stable", "same content");
    const active = watcher();
    await active.start();
    await active.stop();
    const embed = vi.spyOn(LexicalEmbeddingClient.prototype, "embedBatch");
    await active.start();
    expect(embed).not.toHaveBeenCalled();
    expect((await indexed()).get("stable.ts")).toContain("same content");
  });
});
