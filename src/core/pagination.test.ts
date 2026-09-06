import { describe, expect, test } from "vitest";

import {
  createPaginationCursor,
  createPaginationScope,
  decodePaginationCursor,
} from "@core/pagination";

describe("pagination cursors", () => {
  test("round trips a bounded opaque cursor", () => {
    const scope = createPaginationScope({ query: "Widget", files: ["a.ts"] });
    const cursor = createPaginationCursor(scope, 25);

    expect(cursor).toMatch(/^pc1\.[A-Za-z0-9_-]+$/u);
    expect(cursor).not.toContain("Widget");
    expect(cursor).not.toContain("a.ts");
    expect(decodePaginationCursor(cursor, scope)).toEqual({
      ok: true,
      offset: 25,
    });

    const firstCursor = createPaginationCursor(scope, 0);
    expect(decodePaginationCursor(firstCursor, scope)).toEqual({
      ok: true,
      offset: 0,
    });
  });

  test("rejects a cursor from another query scope", () => {
    const firstScope = createPaginationScope({ query: "first" });
    const secondScope = createPaginationScope({ query: "second" });
    const cursor = createPaginationCursor(firstScope, 1);

    expect(decodePaginationCursor(cursor, secondScope)).toEqual({
      ok: false,
      error: "Pagination cursor does not match this query",
    });
  });

  test("rejects malformed, tampered, and non-canonical cursors", () => {
    const scope = createPaginationScope({ query: "x" });
    const cursor = createPaginationCursor(scope, 1);

    expect(decodePaginationCursor("nope", scope).ok).toBe(false);
    expect(decodePaginationCursor(`${cursor}x`, scope).ok).toBe(false);
    expect(
      decodePaginationCursor(
        `pc1.${Buffer.from(JSON.stringify({ version: 1, scope, offset: -1 }), "utf8").toString("base64url")}`,
        scope,
      ).ok,
    ).toBe(false);
  });

  test("produces stable scope hashes regardless of object key order", () => {
    expect(createPaginationScope({ a: 1, b: [2, 3] })).toBe(
      createPaginationScope({ b: [2, 3], a: 1 }),
    );
  });
});
