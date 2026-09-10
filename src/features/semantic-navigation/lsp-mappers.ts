import * as path from "node:path";

import { lspLocationPath, type LspDiagnostic, type LspLocation } from "@core/navigation/lsp";
import { redactSourceText, readSecureTextFile } from "@core/security";

import { boundedText, locationKey, positionFromLsp, stringIndexAtByteOffset } from "./common";
import type { NavigationDiagnostic, NavigationLocation } from "./types";

export function mapLspLocations(
  locations: readonly LspLocation[],
  root: string,
  maxResults: number,
  includeSource: boolean,
  maxSourceBytes: number,
  redact: boolean,
): {
  locations: NavigationLocation[];
  ignoredExternal: number;
  truncated: boolean;
  secretsRedacted: boolean;
} {
  const results: NavigationLocation[] = [];
  const seen = new Set<string>();
  let ignoredExternal = 0;
  let truncated = locations.length > maxResults;
  let secretsRedacted = false;
  for (const location of locations) {
    const securePath = lspLocationPath(location.uri, root);
    if (securePath === undefined) {
      ignoredExternal += 1;
      continue;
    }
    const readResult = readSecureTextFile(securePath, root);
    if (!readResult.ok || readResult.content === undefined) {
      continue;
    }
    const start = positionFromLsp(readResult.content, location.range.start);
    const end = positionFromLsp(readResult.content, location.range.end);
    if (start === undefined || end === undefined) {
      continue;
    }
    const result: NavigationLocation = {
      file_path: path.relative(root, securePath).replace(/\\/gu, "/"),
      start,
      end,
    };
    if (includeSource) {
      const startIndex = stringIndexAtByteOffset(readResult.content, start.offset);
      const endIndex = stringIndexAtByteOffset(readResult.content, end.offset);
      const bounded = boundedText(
        readResult.content.slice(startIndex, endIndex),
        maxSourceBytes,
        redact,
      );
      result.snippet = bounded.text;
      truncated ||= bounded.truncated;
      secretsRedacted ||= bounded.redacted;
    }
    const key = locationKey(result);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(result);
    if (results.length >= maxResults) {
      break;
    }
  }
  return { locations: results, ignoredExternal, truncated, secretsRedacted };
}

export function mapLspDiagnostics(
  diagnostics: readonly LspDiagnostic[],
  content: string,
  maxResults: number,
  redact: boolean,
): {
  diagnostics: NavigationDiagnostic[];
  truncated: boolean;
  secretsRedacted: boolean;
} {
  let secretsRedacted = false;
  const mapped = diagnostics.slice(0, maxResults).flatMap((diagnostic) => {
    const start = positionFromLsp(content, diagnostic.range.start);
    const end = positionFromLsp(content, diagnostic.range.end);
    if (start === undefined || end === undefined) {
      return [];
    }
    const message = redact
      ? redactSourceText(diagnostic.message)
      : { text: diagnostic.message, redacted: false };
    secretsRedacted ||= message.redacted;
    return [
      {
        message: message.text,
        start,
        end,
        ...(diagnostic.severity === undefined ? {} : { severity: String(diagnostic.severity) }),
        ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
        ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
      },
    ];
  });
  return {
    diagnostics: mapped,
    truncated: diagnostics.length > maxResults,
    secretsRedacted,
  };
}
