import { fileURLToPath } from "node:url";

import { resolveSecureFile } from "@core/security";

export function lspLocationPath(uri: string, root: string): string | undefined {
  if (!uri.toLowerCase().startsWith("file:")) {
    return undefined;
  }
  try {
    const filePath = fileURLToPath(uri);
    const secure = resolveSecureFile(filePath, root);
    return secure.ok ? secure.path : undefined;
  } catch {
    return undefined;
  }
}

export function lspPositionToUtf8Offset(
  content: string,
  position: { line: number; character: number },
): number | undefined {
  if (position.line < 0 || position.character < 0) {
    return undefined;
  }
  const lines = content.split("\n");
  const lineText = lines[position.line];
  if (lineText === undefined) {
    return undefined;
  }
  const withoutCr = lineText.replace(/\r$/u, "");
  let codeUnitOffset = 0;
  let prefix: string | undefined;
  for (const codePoint of withoutCr) {
    if (codeUnitOffset + codePoint.length > position.character) {
      return undefined;
    }
    codeUnitOffset += codePoint.length;
    if (codeUnitOffset === position.character) {
      prefix = withoutCr.slice(0, codeUnitOffset);
      break;
    }
  }
  if (position.character === 0) {
    prefix = "";
  } else if (position.character === codeUnitOffset && prefix === undefined) {
    prefix = withoutCr;
  }
  if (prefix === undefined) {
    return undefined;
  }
  const lineStart = lines
    .slice(0, position.line)
    .reduce((total, value) => total + value.length + 1, 0);
  return Buffer.byteLength(content.slice(0, lineStart), "utf8") + Buffer.byteLength(prefix, "utf8");
}
