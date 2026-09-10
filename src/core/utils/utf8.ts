/** Truncate a string without exceeding a UTF-8 byte budget or splitting a code point. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) {
    return value;
  }
  let end = Math.min(maxBytes, encoded.byteLength);
  while (end > 0 && (encoded[end] ?? 0) >> 6 === 0b10) {
    end -= 1;
  }
  return encoded.subarray(0, end).toString("utf8");
}

/** Truncate text and report whether the original value exceeded the budget. */
export function truncateUtf8WithStatus(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const truncated = Buffer.byteLength(value, "utf8") > Math.max(0, maxBytes);
  return {
    text: truncated ? truncateUtf8(value, maxBytes) : value,
    truncated,
  };
}
/** Map a byte offset to a UTF-16 index, rounding down to a whole code point. */
export function stringIndexAtByteOffset(
  value: string,
  byteOffset: number,
): number {
  return truncateUtf8(value, byteOffset).length;
}
