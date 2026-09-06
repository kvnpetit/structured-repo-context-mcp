import * as path from "node:path";

import {
  mergeInstructionSignals,
  redactSourceText,
  scanInstructionSignals,
} from "@core/security";
import { truncateUtf8WithStatus } from "@core/utils/utf8";

import type { FormattedSearchResults, SearchCandidate } from "./types";

function normalizeProjectPath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

export function splitContentParts(content: string): {
  signature?: string;
  documentation?: string;
  body: string;
} {
  const lines = content.split("\n");
  let documentationEnd = 0;
  const documentationLines: string[] = [];
  while (documentationEnd < lines.length) {
    const line = lines[documentationEnd] ?? "";
    if (/^\s*(?:\/\/|#|\/\*|\*|\*\/)/u.test(line) || line.trim() === "") {
      if (line.trim() !== "") {
        documentationLines.push(line);
      }
      documentationEnd += 1;
      continue;
    }
    break;
  }
  const codeLines = lines.slice(documentationEnd);
  const firstCode = codeLines.join("\n");
  const opening = [firstCode.indexOf("{"), firstCode.indexOf("=>")]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const signature =
    opening === undefined
      ? codeLines[0]?.trim()
      : firstCode.slice(0, opening).trim();
  const body =
    opening === undefined ? firstCode.trim() : firstCode.slice(opening).trim();
  return {
    ...(documentationLines.length === 0
      ? {}
      : { documentation: documentationLines.join("\n") }),
    ...(signature === undefined || signature.length === 0 ? {} : { signature }),
    body,
  };
}

export function formatResults(
  results: SearchCandidate[],
  baseDir: string,
  redactSecrets: boolean,
  confidences: readonly number[],
  maxContentBytes: number,
): FormattedSearchResults {
  let redacted = false;
  let contentTruncatedCount = 0;
  const instructionScans: ReturnType<typeof scanInstructionSignals>[] = [];
  const formatted = results.map((result, index) => {
    const source = redactSecrets
      ? redactSourceText(result.chunk.content)
      : { text: result.chunk.content, redacted: false };
    const bounded = truncateUtf8WithStatus(source.text, maxContentBytes);
    redacted ||= source.redacted;
    contentTruncatedCount += bounded.truncated ? 1 : 0;
    const filePath = normalizeProjectPath(
      path.relative(baseDir, result.chunk.filePath),
    );
    instructionScans.push(
      scanInstructionSignals(result.chunk.content, { source: filePath }),
    );
    return {
      filePath,
      language: result.chunk.language,
      startLine: result.chunk.startLine,
      endLine: result.chunk.endLine,
      content: bounded.text,
      score: Number(result.score.toFixed(6)),
      confidence: confidences[index] ?? 0,
      ...(bounded.truncated ? { content_truncated: true } : {}),
      ...(result.isNeighbor
        ? {
            is_neighbor: true,
            ...(result.neighborOf === undefined
              ? {}
              : { neighbor_of: result.neighborOf }),
            ...(result.neighborDistance === undefined
              ? {}
              : { neighbor_distance: result.neighborDistance }),
          }
        : {}),
      parts: splitContentParts(bounded.text),
      symbolName: result.chunk.symbolName,
      symbolType: result.chunk.symbolType,
    };
  });
  return {
    results: formatted,
    redacted,
    contentTruncatedCount,
    instruction_signals: mergeInstructionSignals(instructionScans),
  };
}
