import * as path from "node:path";

import { isSafeGitRelativePath, normalizeGitPath, runLocalGit } from "@core/git";
import { redactSourceText, readSecureTextFile, resolveSecureFile } from "@core/security";

import { MAX_FILES } from "./schema";
import type {
  BlameEntry,
  ChangeStatus,
  HistoryEntry,
  HotspotAnalysis,
  HotspotEntry,
  RevisionChange,
  StatusEntry,
} from "./types";

const MAX_CODEOWNER_LINES = 1_000;

function statusKind(index: string, worktree: string): ChangeStatus {
  const code = `${index}${worktree}`;
  if (code.includes("?") || code.includes("A")) {
    return "added";
  }
  if (code.includes("D")) {
    return "deleted";
  }
  if (code.includes("R")) {
    return "renamed";
  }
  if (code.includes("M")) {
    return "modified";
  }
  return "unknown";
}

export function parseStatus(value: string): {
  entries: StatusEntry[];
  truncated: boolean;
} {
  const entries = value
    .split("\0")
    .filter((entry) => entry.length >= 3)
    .map((entry) => {
      const index = entry[0] ?? " ";
      const worktree = entry[1] ?? " ";
      const filePath = normalizeGitPath(entry.slice(3));
      return {
        path: filePath,
        index,
        worktree,
        status: statusKind(index, worktree),
        staged: index !== " " && index !== "?",
        untracked: index === "?" && worktree === "?",
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    entries: entries.slice(0, MAX_FILES),
    truncated: entries.length > MAX_FILES,
  };
}

export function parseHistory(value: string): HistoryEntry[] {
  const fields = value.split("\0").filter(Boolean);
  const entries: HistoryEntry[] = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const commit = fields[index];
    const author = fields[index + 1];
    const date = fields[index + 2];
    const subject = fields[index + 3];
    if (
      commit !== undefined &&
      author !== undefined &&
      date !== undefined &&
      subject !== undefined
    ) {
      entries.push({ commit, author, date, subject });
    }
  }
  return entries;
}

export function parseHotspots(
  value: string,
  maxCommits: number,
  maxFiles: number,
): HotspotAnalysis {
  const aggregated = new Map<string, Omit<HotspotEntry, "churn"> & { churn: number }>();
  let commitsSeen = 0;
  let currentCommit: { commit: string; date: string } | undefined;

  for (const line of value.split("\n")) {
    const header = /^(?<commit>[a-f0-9]{7,40})\0(?<date>[^\0]*)\0$/iu.exec(line);
    if (header?.groups?.commit !== undefined) {
      commitsSeen += 1;
      currentCommit =
        commitsSeen <= maxCommits
          ? { commit: header.groups.commit, date: header.groups.date ?? "" }
          : undefined;
      continue;
    }
    if (currentCommit === undefined) {
      continue;
    }
    const fields = line.split("\t");
    const additionsField = fields[0];
    const deletionsField = fields[1];
    const fileField = fields.slice(2).join("\t");
    if (
      additionsField === undefined ||
      deletionsField === undefined ||
      fileField.length === 0 ||
      (additionsField !== "-" && !/^\d+$/u.test(additionsField)) ||
      (deletionsField !== "-" && !/^\d+$/u.test(deletionsField))
    ) {
      continue;
    }
    const file = normalizeGitPath(fileField);
    if (!isSafeGitRelativePath(file)) {
      continue;
    }
    const binary = additionsField === "-" || deletionsField === "-";
    const additions = binary ? 0 : Number(additionsField);
    const deletions = binary ? 0 : Number(deletionsField);
    const existing = aggregated.get(file);
    if (existing === undefined) {
      aggregated.set(file, {
        path: file,
        commits: 1,
        additions,
        deletions,
        binary_changes: binary ? 1 : 0,
        churn: additions + deletions + (binary ? 1 : 0),
        last_commit: currentCommit.commit,
        last_date: currentCommit.date,
      });
    } else {
      existing.commits += 1;
      existing.additions += additions;
      existing.deletions += deletions;
      existing.binary_changes += binary ? 1 : 0;
      existing.churn += additions + deletions + (binary ? 1 : 0);
    }
  }

  const allFiles = [...aggregated.values()].sort(
    (left, right) =>
      right.churn - left.churn ||
      right.commits - left.commits ||
      left.path.localeCompare(right.path),
  );
  return {
    commits_analyzed: Math.min(commitsSeen, maxCommits),
    files: allFiles.slice(0, maxFiles),
    truncated: commitsSeen > maxCommits || allFiles.length > maxFiles,
  };
}

function revisionStatus(value: string): ChangeStatus {
  const code = value[0] ?? "";
  if (code === "A" || code === "C") {
    return "added";
  }
  if (code === "D") {
    return "deleted";
  }
  if (code === "R") {
    return "renamed";
  }
  if (code === "M" || code === "T") {
    return "modified";
  }
  return "unknown";
}

export function parseRevisionChanges(
  value: string,
  maxFiles: number,
): { files: RevisionChange[]; filesChanged: number; truncated: boolean } {
  const tokens = value.split("\0").filter(Boolean);
  const allFiles: RevisionChange[] = [];
  for (let index = 0; index < tokens.length; ) {
    const statusCode = tokens[index];
    index += 1;
    if (statusCode === undefined || tokens[index] === undefined) {
      break;
    }
    const status = revisionStatus(statusCode);
    const rawFirstPath = tokens[index];
    if (rawFirstPath === undefined) {
      break;
    }
    const firstPath = normalizeGitPath(rawFirstPath);
    index += 1;
    if (!isSafeGitRelativePath(firstPath)) {
      if (statusCode.startsWith("R") || statusCode.startsWith("C")) {
        index += 1;
      }
      continue;
    }
    if (statusCode.startsWith("R") || statusCode.startsWith("C")) {
      const secondPath = tokens[index];
      index += 1;
      if (secondPath === undefined || !isSafeGitRelativePath(secondPath)) {
        continue;
      }
      allFiles.push({
        path: normalizeGitPath(secondPath),
        status,
        old_path: firstPath,
      });
    } else {
      allFiles.push({ path: firstPath, status });
    }
  }
  allFiles.sort(
    (left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status),
  );
  return {
    files: allFiles.slice(0, maxFiles),
    filesChanged: allFiles.length,
    truncated: allFiles.length > maxFiles,
  };
}

export async function resolveLocalRevision(root: string, revision: string): Promise<string> {
  const result = await runLocalGit(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${revision}^{commit}`,
  ]);
  const resolved = result.stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(resolved)) {
    throw new Error("Git revision did not resolve to a commit");
  }
  return resolved;
}

export function parseBlame(value: string, maxLines: number): BlameEntry[] {
  const entries: BlameEntry[] = [];
  let current: Partial<BlameEntry> | undefined;
  for (const line of value.split("\n")) {
    const header = /^(?<commit>[a-f0-9]{7,40}) \d+ (?<line>\d+)/iu.exec(line);
    if (header?.groups?.commit !== undefined && header.groups.line !== undefined) {
      if (current?.commit !== undefined && current.line !== undefined) {
        entries.push({
          line: current.line,
          commit: current.commit,
          author: current.author,
          date: current.date,
          summary: current.summary,
        });
      }
      current = {
        commit: header.groups.commit,
        line: Number(header.groups.line),
      };
      if (entries.length >= maxLines) {
        break;
      }
      continue;
    }
    if (current === undefined) {
      continue;
    }
    if (line.startsWith("author ")) {
      current.author = line.slice("author ".length);
    } else if (line.startsWith("author-time ")) {
      current.date = line.slice("author-time ".length);
    } else if (line.startsWith("summary ")) {
      current.summary = line.slice("summary ".length);
    }
  }
  if (current?.commit !== undefined && current.line !== undefined && entries.length < maxLines) {
    entries.push({
      line: current.line,
      commit: current.commit,
      author: current.author,
      date: current.date,
      summary: current.summary,
    });
  }
  return entries;
}

export function requestedFiles(values: readonly string[]): string[] | string {
  const normalized = new Set<string>();
  for (const value of values) {
    if (!isSafeGitRelativePath(value)) {
      return "Files must be safe project-relative paths";
    }
    normalized.add(normalizeGitPath(value));
  }
  return [...normalized].sort();
}

export function readCodeowners(root: string): {
  path?: string;
  lines: string[];
} {
  for (const candidate of [
    "CODEOWNERS",
    ".github/CODEOWNERS",
    ".gitlab/CODEOWNERS",
    "docs/CODEOWNERS",
  ]) {
    const resolved = resolveSecureFile(path.join(root, candidate), root);
    if (!resolved.ok) {
      continue;
    }
    const read = readSecureTextFile(resolved.path, root);
    if (read.ok && read.content !== undefined) {
      return {
        path: candidate,
        lines: read.content.split(/\r?\n/u).slice(0, MAX_CODEOWNER_LINES),
      };
    }
  }
  return { lines: [] };
}

export function redactText(value: string, enabled: boolean): { text: string; redacted: boolean } {
  return enabled ? redactSourceText(value) : { text: value, redacted: false };
}
