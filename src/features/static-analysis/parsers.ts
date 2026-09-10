import * as path from "node:path";

import { isSafeGitRelativePath } from "@core/git";
import { redactSourceText, resolveSecureDirectory, resolveSecureFile } from "@core/security";

import type { StaticFinding } from "./types";

export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isSafeInteger(field) && field >= 0 ? field : undefined;
}

function positiveNumberField(value: unknown, key: string): number | undefined {
  const number = numberField(value, key);
  return number === undefined || number < 1 ? undefined : number;
}

function astGrepLine(value: unknown, key: string): number | undefined {
  const number = numberField(value, key);
  return number === undefined ? undefined : number + 1;
}

function normalizeFindingPath(root: string, value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  let candidate = value.trim();
  if (/^file:\/\//iu.test(candidate)) {
    candidate = candidate.replace(/^file:\/\//iu, "");
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      return undefined;
    }
    if (/^\/[a-z]:[\\/]/iu.test(candidate)) {
      candidate = candidate.slice(1);
    }
  }
  if (path.isAbsolute(candidate)) {
    const relative = path.relative(root, candidate).replace(/\\/gu, "/");
    return isSafeGitRelativePath(relative) ? relative : undefined;
  }
  candidate = candidate.replace(/\\/gu, "/").replace(/^\.\//u, "");
  return isSafeGitRelativePath(candidate) ? candidate : undefined;
}

export function parseAstGrep(root: string, payload: unknown, maxResults: number): StaticFinding[] {
  const values = Array.isArray(payload)
    ? payload
    : typeof payload === "object" &&
        payload !== null &&
        Array.isArray((payload as { matches?: unknown }).matches)
      ? (payload as { matches: unknown[] }).matches
      : [];
  return values.slice(0, maxResults).flatMap((value) => {
    if (typeof value !== "object" || value === null) {
      return [];
    }
    const range = (value as { range?: unknown }).range;
    const start =
      typeof range === "object" && range !== null
        ? (range as { start?: unknown }).start
        : undefined;
    const end =
      typeof range === "object" && range !== null ? (range as { end?: unknown }).end : undefined;
    return [
      {
        backend: "ast-grep" as const,
        rule_id: stringField(value, "ruleId"),
        file_path: normalizeFindingPath(root, stringField(value, "file")),
        start_line: astGrepLine(start, "line"),
        end_line: astGrepLine(end, "line"),
        start_column: numberField(start, "column"),
        end_column: numberField(end, "column"),
        snippet: stringField(value, "text"),
      },
    ];
  });
}

export function parseSemgrep(root: string, payload: unknown, maxResults: number): StaticFinding[] {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !Array.isArray((payload as { results?: unknown }).results)
  ) {
    return [];
  }
  return (payload as { results: unknown[] }).results.slice(0, maxResults).flatMap((value) => {
    if (typeof value !== "object" || value === null) {
      return [];
    }
    const extra = (value as { extra?: unknown }).extra;
    return [
      {
        backend: "semgrep" as const,
        rule_id: stringField(value, "check_id"),
        message: stringField(extra, "message"),
        file_path: normalizeFindingPath(root, stringField(value, "path")),
        start_line: positiveNumberField((value as { start?: unknown }).start, "line"),
        end_line: positiveNumberField((value as { end?: unknown }).end, "line"),
        start_column: positiveNumberField((value as { start?: unknown }).start, "col"),
        end_column: positiveNumberField((value as { end?: unknown }).end, "col"),
        severity: stringField(extra, "severity"),
        snippet: stringField(extra, "lines"),
      },
    ];
  });
}

export function parseCodeql(root: string, payload: unknown, maxResults: number): StaticFinding[] {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !Array.isArray((payload as { runs?: unknown }).runs)
  ) {
    return [];
  }
  const findings: StaticFinding[] = [];
  for (const run of (payload as { runs: unknown[] }).runs) {
    if (
      typeof run !== "object" ||
      run === null ||
      !Array.isArray((run as { results?: unknown }).results)
    ) {
      continue;
    }
    for (const value of (run as { results: unknown[] }).results) {
      if (findings.length >= maxResults || typeof value !== "object" || value === null) {
        break;
      }
      const locationsValue = (value as { locations?: unknown }).locations;
      const locations: unknown[] = Array.isArray(locationsValue) ? locationsValue : [];
      const location = locations[0];
      const physical =
        typeof location === "object" && location !== null
          ? (location as { physicalLocation?: unknown }).physicalLocation
          : undefined;
      const region =
        typeof physical === "object" && physical !== null
          ? (physical as { region?: unknown }).region
          : undefined;
      const artifact =
        typeof physical === "object" && physical !== null
          ? (physical as { artifactLocation?: unknown }).artifactLocation
          : undefined;
      const message = (value as { message?: unknown }).message;
      findings.push({
        backend: "codeql",
        rule_id: stringField(value, "ruleId"),
        message: stringField(message, "text"),
        file_path: normalizeFindingPath(root, stringField(artifact, "uri")),
        start_line: positiveNumberField(region, "startLine"),
        end_line: positiveNumberField(region, "endLine"),
        start_column: positiveNumberField(region, "startColumn"),
        end_column: positiveNumberField(region, "endColumn"),
      });
    }
  }
  return findings;
}

export function redactFindings(
  findings: StaticFinding[],
  enabled: boolean,
): {
  findings: StaticFinding[];
  redacted: boolean;
} {
  if (!enabled) {
    return { findings, redacted: false };
  }
  let redacted = false;
  const redact = (value: string | undefined): string | undefined => {
    if (value === undefined) {
      return undefined;
    }
    const result = redactSourceText(value);
    redacted ||= result.redacted;
    return result.text;
  };
  return {
    findings: findings.map((finding) => ({
      ...finding,
      ...(finding.message === undefined ? {} : { message: redact(finding.message) }),
      ...(finding.snippet === undefined ? {} : { snippet: redact(finding.snippet) }),
    })),
    redacted,
  };
}

export function safeCodeqlPath(
  root: string,
  value: string,
  kind: "directory" | "file",
): string | undefined {
  if (!isSafeGitRelativePath(value)) {
    return undefined;
  }
  const absolute = path.resolve(root, value);
  const resolved =
    kind === "directory" ? resolveSecureDirectory(absolute) : resolveSecureFile(absolute, root);
  return resolved.ok ? resolved.path : undefined;
}
