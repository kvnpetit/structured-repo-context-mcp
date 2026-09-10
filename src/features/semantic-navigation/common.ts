import type { Position } from "@core/ast/types";
import { lspPositionToUtf8Offset } from "@core/navigation/lsp";
import { redactSourceText } from "@core/security";

import type { NavigationLocation } from "./types";

export function stringIndexAtByteOffset(content: string, byteOffset: number): number {
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(content.slice(0, middle), "utf8") <= byteOffset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

export function positionFromLsp(
  content: string,
  position: { line: number; character: number },
): Position | undefined {
  const offset = lspPositionToUtf8Offset(content, position);
  if (offset === undefined) {
    return undefined;
  }
  const lineText = content.split("\n")[position.line]?.replace(/\r$/u, "") ?? "";
  const prefix = lineText.slice(0, position.character);
  return {
    line: position.line + 1,
    column: Array.from(prefix).length,
    offset,
  };
}

export function renderHoverValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(renderHoverValue).filter(Boolean).join("\n\n");
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.value === "string") {
      return record.value;
    }
    if (typeof record.contents === "string") {
      return record.contents;
    }
  }
  return "";
}

export function boundedText(
  value: string,
  maxBytes: number,
  redact: boolean,
): { text: string; truncated: boolean; redacted: boolean } {
  const source = redact ? redactSourceText(value) : { text: value, redacted: false };
  const bounded = source.text.slice(0, stringIndexAtByteOffset(source.text, maxBytes));
  return {
    text: bounded,
    truncated: bounded.length < source.text.length,
    redacted: source.redacted,
  };
}

export function locationKey(location: NavigationLocation): string {
  return `${location.file_path}:${String(location.start.offset)}:${String(location.end.offset)}`;
}

export function identifierAtPosition(
  content: string,
  line: number,
  column: number,
): string | undefined {
  const lineText = content.split("\n")[line - 1]?.replace(/\r$/u, "");
  if (lineText === undefined) {
    return undefined;
  }
  const characters = Array.from(lineText);
  const position = Math.min(column, characters.length);
  const isIdentifierCharacter = (value: string | undefined): boolean =>
    value !== undefined && /[\p{L}\p{N}_$]/u.test(value);
  let start = position;
  if (!isIdentifierCharacter(characters[start]) && start > 0) {
    start -= 1;
  }
  if (!isIdentifierCharacter(characters[start])) {
    return undefined;
  }
  let begin = start;
  let end = start + 1;
  while (begin > 0 && isIdentifierCharacter(characters[begin - 1])) {
    begin -= 1;
  }
  while (end < characters.length && isIdentifierCharacter(characters[end])) {
    end += 1;
  }
  const value = characters.slice(begin, end).join("");
  return /^[\p{L}_$]/u.test(value) ? value : undefined;
}
