import * as crypto from "node:crypto";

const CURSOR_PREFIX = "pc1.";
const CURSOR_VERSION = 1 as const;
const MAX_CURSOR_BYTES = 1_024;
const MAX_OFFSET = 10_000_000;

export interface PaginationCursor {
  version: typeof CURSOR_VERSION;
  scope: string;
  offset: number;
}

export type PaginationCursorResult =
  { ok: true; offset: number } | { ok: false; error: string };

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableValue).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
    .join(",")}}`;
}

/** Build a compact, opaque scope hash for a bounded query. */
export function createPaginationScope(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(stableValue(value), "utf8")
    .digest("hex");
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string): string | undefined {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length === 0 || decoded.toString("base64url") !== value) {
      return undefined;
    }
    return decoded.toString("utf8");
  } catch {
    return undefined;
  }
}

/** Create an opaque cursor that never contains project paths or source text. */
export function createPaginationCursor(scope: string, offset: number): string {
  if (!/^[a-f0-9]{64}$/u.test(scope)) {
    throw new Error("Pagination scope must be a SHA-256 hash");
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
    throw new Error("Pagination offset is outside the supported range");
  }
  const cursor: PaginationCursor = {
    version: CURSOR_VERSION,
    scope,
    offset,
  };
  return `${CURSOR_PREFIX}${encodeBase64Url(JSON.stringify(cursor))}`;
}

/** Validate a cursor against the exact query scope that created it. */
export function decodePaginationCursor(
  cursor: string | undefined,
  expectedScope: string,
): PaginationCursorResult {
  if (cursor === undefined) {
    return { ok: true, offset: 0 };
  }
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_BYTES) {
    return { ok: false, error: "Pagination cursor is invalid" };
  }
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    return { ok: false, error: "Pagination cursor version is unsupported" };
  }
  const encoded = cursor.slice(CURSOR_PREFIX.length);
  const decoded = decodeBase64Url(encoded);
  if (decoded === undefined) {
    return { ok: false, error: "Pagination cursor encoding is invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    return { ok: false, error: "Pagination cursor payload is invalid" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Pagination cursor payload is invalid" };
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "offset" ||
    keys[1] !== "scope" ||
    keys[2] !== "version" ||
    record.version !== CURSOR_VERSION ||
    record.scope !== expectedScope ||
    typeof record.scope !== "string" ||
    !Number.isSafeInteger(record.offset) ||
    (record.offset as number) < 0 ||
    (record.offset as number) > MAX_OFFSET
  ) {
    return { ok: false, error: "Pagination cursor does not match this query" };
  }
  return { ok: true, offset: record.offset as number };
}
