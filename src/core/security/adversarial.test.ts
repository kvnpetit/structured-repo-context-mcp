import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  isPathWithin,
  redactSourceText,
  redactStructuredValue,
  resolveSecurePath,
  scanInstructionSignals,
} from "@core/security";
import {
  createPaginationCursor,
  createPaginationScope,
  decodePaginationCursor,
} from "@core/pagination";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function deterministicValues(count: number): string[] {
  const alphabet = "abcXYZ0123 ._-/\\:;\0\n\r\t<>[]{}()'\"`\u202e\u2066é漢字";
  let state = 0x9e3779b9;
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    let value = "";
    const length = (index * 17) % 73;
    for (let offset = 0; offset < length; offset += 1) {
      state = Math.imul(state ^ (state >>> 15), 0x45d9f3b) | 0;
      state ^= state >>> 13;
      value += alphabet[Math.abs(state) % alphabet.length] ?? "a";
    }
    values.push(value);
  }
  return values;
}

describe("adversarial property checks", () => {
  test("secure path resolution never escapes its explicit root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-fuzz-"));
    directories.push(root);

    for (const value of deterministicValues(600)) {
      expect(() => {
        const result = resolveSecurePath(value || ".", {
          root,
          allowMissing: true,
        });
        if (result.ok) {
          expect(isPathWithin(root, result.path)).toBe(true);
        }
      }).not.toThrow();
    }
  });

  test("cursor parsing is total and valid cursors round-trip", () => {
    const scope = createPaginationScope({ project: "fixture", query: "safe" });
    for (const value of deterministicValues(600)) {
      expect(() => decodePaginationCursor(value, scope)).not.toThrow();
    }
    for (const offset of [0, 1, 17, 10_000_000]) {
      const cursor = createPaginationCursor(scope, offset);
      expect(decodePaginationCursor(cursor, scope)).toEqual({
        ok: true,
        offset,
      });
      expect(decodePaginationCursor(cursor, `${scope.slice(0, -1)}0`).ok).toBe(false);
    }
  });

  test("instruction scanning remains bounded and reports byte-safe positions", () => {
    for (const value of deterministicValues(600)) {
      const signals = scanInstructionSignals(value.repeat(4), {
        maxBytes: 32,
        maxSignals: 3,
      });
      expect(signals.scanned_bytes).toBeLessThanOrEqual(32);
      expect(signals.count).toBeLessThanOrEqual(3);
      expect(signals.count).toBe(signals.signals.length);
      for (const signal of signals.signals) {
        expect(signal.offset).toBeGreaterThanOrEqual(0);
        expect(signal.offset).toBeLessThanOrEqual(signals.scanned_bytes);
        expect(signal.line).toBeGreaterThan(0);
        expect(signal.column).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("redaction is idempotent for structured untrusted values", () => {
    for (const value of deterministicValues(150)) {
      const source = `token = ${value} sk-${"a".repeat(24)}\n${value}`;
      const redacted = redactSourceText(source);
      expect(redactSourceText(redacted.text).text).toBe(redacted.text);
      const structured = redactStructuredValue({ source, nested: [value] });
      expect(redactStructuredValue(structured.value)).toEqual({
        value: structured.value,
        redacted: false,
      });
    }
  });
});
