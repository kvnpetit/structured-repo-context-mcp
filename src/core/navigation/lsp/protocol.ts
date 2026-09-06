import type { LspDiagnostic, LspHover, LspLocation } from "./types";

const MAX_LSP_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_LSP_HEADER_BYTES = 16 * 1024;
export const MAX_LSP_BUFFER_BYTES =
  MAX_LSP_MESSAGE_BYTES + MAX_LSP_HEADER_BYTES + 4;

export function jsonRpcMessage(message: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.byteLength > MAX_LSP_MESSAGE_BYTES) {
    throw new Error("Language server message exceeds the local size limit");
  }
  return Buffer.concat([
    Buffer.from(`Content-Length: ${String(body.byteLength)}\r\n\r\n`, "ascii"),
    body,
  ]);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseLocation(value: unknown): LspLocation | undefined {
  if (
    !isRecord(value) ||
    typeof value.uri !== "string" ||
    !isRecord(value.range)
  ) {
    return undefined;
  }
  const start = value.range.start;
  const end = value.range.end;
  if (!isRecord(start) || !isRecord(end)) {
    return undefined;
  }
  if (
    !isNumber(start.line) ||
    !isNumber(start.character) ||
    !isNumber(end.line) ||
    !isNumber(end.character)
  ) {
    return undefined;
  }
  return {
    uri: value.uri,
    range: {
      start: { line: start.line, character: start.character },
      end: { line: end.line, character: end.character },
    },
  };
}

function parseLocationLink(value: unknown): LspLocation | undefined {
  if (!isRecord(value) || typeof value.targetUri !== "string") {
    return undefined;
  }
  const range = value.targetSelectionRange ?? value.targetRange;
  if (!isRecord(range)) {
    return undefined;
  }
  return parseLocation({ uri: value.targetUri, range });
}

export function parseLocations(value: unknown): LspLocation[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => parseLocation(item) ?? parseLocationLink(item))
      .filter((item): item is LspLocation => item !== undefined);
  }
  const location = parseLocation(value) ?? parseLocationLink(value);
  return location === undefined ? [] : [location];
}

export function parseHover(value: unknown): LspHover | null {
  if (!isRecord(value) || !("contents" in value)) {
    return null;
  }
  const rangeValue = value.range;
  const range =
    rangeValue === undefined
      ? undefined
      : parseLocation({ uri: "", range: rangeValue })?.range;
  return {
    contents: value.contents,
    ...(range === undefined ? {} : { range }),
  };
}

export function parseDiagnostics(value: unknown): LspDiagnostic[] {
  const items =
    isRecord(value) && Array.isArray(value.items)
      ? value.items
      : Array.isArray(value)
        ? value
        : [];
  return items.flatMap((item) => {
    if (!isRecord(item) || typeof item.message !== "string") {
      return [];
    }
    const range = parseLocation({ uri: "", range: item.range })?.range;
    if (range === undefined) {
      return [];
    }
    const diagnostic: LspDiagnostic = {
      message: item.message,
      range,
      ...(isNumber(item.severity) ? { severity: item.severity } : {}),
      ...(typeof item.code === "string" || typeof item.code === "number"
        ? { code: item.code }
        : {}),
      ...(typeof item.source === "string" ? { source: item.source } : {}),
    };
    return [diagnostic];
  });
}

export function parseTypeHierarchyItems(value: unknown): LspLocation[] {
  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : [];
  return items
    .map((item) => {
      if (!isRecord(item) || typeof item.uri !== "string") {
        return undefined;
      }
      const range = item.selectionRange ?? item.range;
      return parseLocation({ uri: item.uri, range });
    })
    .filter((item): item is LspLocation => item !== undefined);
}

export interface LspFrameParseResult {
  messages: Buffer[];
  remainder: Buffer;
  error?: string;
}

/**
 * Parse bounded LSP/JSON-RPC frames without allowing a local server to grow
 * the receive buffer indefinitely. The parser deliberately leaves JSON
 * validation to the client so one malformed frame does not desynchronize the
 * transport.
 */
export function parseLspFrames(buffer: Buffer): LspFrameParseResult {
  if (buffer.byteLength > MAX_LSP_BUFFER_BYTES) {
    return {
      messages: [],
      remainder: Buffer.alloc(0),
      error: "Language server receive buffer exceeds the local size limit",
    };
  }

  const messages: Buffer[] = [];
  let remainder = buffer;
  while (remainder.byteLength > 0) {
    if (remainder.byteLength > MAX_LSP_BUFFER_BYTES) {
      return {
        messages,
        remainder: Buffer.alloc(0),
        error: "Language server receive buffer exceeds the local size limit",
      };
    }
    const headerEnd = remainder.indexOf(Buffer.from("\r\n\r\n", "ascii"));
    if (headerEnd < 0) {
      if (remainder.byteLength > MAX_LSP_HEADER_BYTES) {
        return {
          messages,
          remainder: Buffer.alloc(0),
          error: "Language server header exceeds the local size limit",
        };
      }
      return { messages, remainder };
    }
    if (headerEnd > MAX_LSP_HEADER_BYTES) {
      return {
        messages,
        remainder: Buffer.alloc(0),
        error: "Language server header exceeds the local size limit",
      };
    }
    const header = remainder.subarray(0, headerEnd).toString("ascii");
    const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/iu.exec(header);
    const bodyStart = headerEnd + 4;
    if (lengthMatch?.[1] === undefined) {
      remainder = remainder.subarray(bodyStart);
      continue;
    }
    const bodyLength = Number(lengthMatch[1]);
    if (!Number.isSafeInteger(bodyLength) || bodyLength < 0) {
      remainder = remainder.subarray(bodyStart);
      continue;
    }
    if (bodyLength > MAX_LSP_MESSAGE_BYTES) {
      return {
        messages,
        remainder: Buffer.alloc(0),
        error: "Language server message exceeds the local size limit",
      };
    }
    const bodyEnd = bodyStart + bodyLength;
    if (remainder.byteLength < bodyEnd) {
      return { messages, remainder };
    }
    messages.push(remainder.subarray(bodyStart, bodyEnd));
    remainder = remainder.subarray(bodyEnd);
  }
  return { messages, remainder };
}
