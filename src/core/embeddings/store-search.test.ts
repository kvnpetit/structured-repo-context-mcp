import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { searchFts, searchLexical } from "./store-search";

function row(id: string, content: string) {
  return {
    id,
    content,
    filePath: `/project/${id}.ts`,
    language: "typescript",
    startLine: 1,
    endLine: 1,
    symbolName: "",
    symbolType: "",
    vector: [1, 0, 0, 0],
  };
}

describe("streaming lexical search with native LanceDB", () => {
  let root: string;
  let database: lancedb.Connection;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "src-lexical-stream-"));
    database = await lancedb.connect(root);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (path.dirname(root) !== path.resolve(os.tmpdir())) {
      throw new Error("Unexpected lexical search fixture directory");
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("scans every native batch, omits vectors and finds a winner beyond the first batch", async () => {
    const rows = Array.from({ length: 12_289 }, (_, index) =>
      row(`entry-${String(index).padStart(5, "0")}`, "needle"),
    );
    const last = rows.at(-1);
    if (last === undefined) {
      throw new Error("Missing final fixture row");
    }
    last.content = "needle needle needle needle needle";
    const table = await database.createTable("chunks", rows.slice(0, 4096));
    await table.add(rows.slice(4096, 8192));
    await table.add(rows.slice(8192));
    const query = table.query();
    const iterator = query[Symbol.asyncIterator].bind(query);
    let batches = 0;
    let visited = 0;
    const batchLengths: number[] = [];
    const fields = new Set<string>();
    vi.spyOn(query, Symbol.asyncIterator).mockImplementation(
      async function* () {
        const stream = iterator();
        for (;;) {
          const next = await stream.next();
          if (next.done) {
            return;
          }
          batches += 1;
          visited += next.value.numRows;
          batchLengths.push(next.value.numRows);
          next.value.schema.fields.forEach((field) => {
            fields.add(field.name);
          });
          yield next.value;
        }
      },
    );
    vi.spyOn(query, "toArray").mockRejectedValue(
      new Error("Unbounded materialization"),
    );
    vi.spyOn(query, "toArrow").mockRejectedValue(
      new Error("Unbounded materialization"),
    );
    vi.spyOn(table, "query").mockReturnValue(query);

    const results = await searchLexical(table, "needle", 3);
    expect(results.map((result) => result.chunk.id)).toEqual([
      last.id,
      "entry-00000",
      "entry-00001",
    ]);
    expect(results.map((result) => result.score)).toEqual([7, 3, 3]);
    expect(visited).toBe(rows.length);
    expect(batches).toBeGreaterThan(1);
    expect(Math.max(...batchLengths)).toBeLessThan(rows.length);
    expect(fields.has("vector")).toBe(false);
    expect(results).toHaveLength(3);
    expect(Object.getPrototypeOf(results[0]?.chunk)).toBe(Object.prototype);
  });

  test("uses deterministic tie order regardless of insertion or fragment order", async () => {
    const first = await database.createTable("first", [
      row("c", "needle"),
      row("a", "needle"),
    ]);
    await first.add([row("b", "needle"), row("d", "needle")]);
    const second = await database.createTable("second", [
      row("d", "needle"),
      row("b", "needle"),
    ]);
    await second.add([row("a", "needle"), row("c", "needle")]);
    for (const table of [first, second]) {
      for (const limit of [1, 2, 4, 10]) {
        const results = await searchLexical(table, "needle", limit);
        expect(results.map((result) => result.chunk.id)).toEqual(
          ["a", "b", "c", "d"].slice(0, limit),
        );
        expect(results.length).toBeLessThanOrEqual(limit);
      }
    }
  });

  test("preserves content, symbol and path weights and excludes unrelated rows", async () => {
    const symbol = { ...row("symbol", "none"), symbolName: "needle" };
    const table = await database.createTable("weights", [
      row("plain", "needle"),
      row("repeated", "needle needle"),
      symbol,
      row("path-needle", "none"),
      row("unrelated", "none"),
    ]);
    const results = await searchLexical(table, "needle", 20);
    expect(results.map((result) => [result.chunk.id, result.score])).toEqual([
      ["repeated", 4],
      ["plain", 3],
      ["symbol", 3],
      ["path-needle", 0.5],
    ]);
  });

  test("the FTS failure path uses streaming lexical results", async () => {
    const table = await database.createTable("fallback", [
      row("b", "needle"),
      row("a", "needle"),
    ]);
    const results = await searchFts(
      table,
      async () => Promise.resolve(),
      "needle",
      1,
    );
    expect(results.map((result) => result.chunk.id)).toEqual(["a"]);
  });

  test("matches a complete ranking oracle across varied scores and heap sizes", async () => {
    const rows = Array.from({ length: 257 }, (_, index) => {
      const repetitions = (index * 17) % 23;
      return {
        data: row(
          `id-${String(index).padStart(4, "0")}`,
          repetitions === 0 ? "unrelated" : "needle ".repeat(repetitions),
        ),
        score: repetitions === 0 ? 0 : repetitions + 2,
      };
    });
    const table = await database.createTable(
      "ranking",
      rows.toReversed().map((entry) => entry.data),
    );
    const expected = rows
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.data.id.localeCompare(right.data.id),
      );
    for (const limit of [1, 7, 40, 300]) {
      const results = await searchLexical(table, "needle", limit);
      expect(results.map((result) => [result.chunk.id, result.score])).toEqual(
        expected.slice(0, limit).map((entry) => [entry.data.id, entry.score]),
      );
    }
  });

  test("returns no results without scanning for empty terms or invalid limits", async () => {
    const table = await database.createTable("empty", [row("entry", "needle")]);
    const query = vi.spyOn(table, "query");
    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(await searchLexical(table, "needle", limit)).toEqual([]);
    }
    expect(await searchLexical(table, "!!!", 10)).toEqual([]);
    expect(await searchLexical(null, "needle", 10)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
