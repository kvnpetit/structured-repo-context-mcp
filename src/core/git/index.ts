import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  createSafeLocalToolEnvironment,
  safeErrorMessage,
} from "@core/security";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

export async function runLocalGit(
  directory: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", ["-C", directory, ...args], {
    cwd: directory,
    windowsHide: true,
    maxBuffer: GIT_MAX_BUFFER,
    shell: false,
    timeout: GIT_TIMEOUT_MS,
    env: {
      ...createSafeLocalToolEnvironment(),
      // Git context is read-only: never wait for credentials, a pager, or an
      // editor, and ignore system-wide config that a project cannot control.
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      GIT_EDITOR: "true",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      // Partial-clone promisor remotes must not turn a read-only context
      // request into an implicit network fetch.
      GIT_NO_LAZY_FETCH: "1",
    },
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export function safeGitError(error: unknown, fallback: string): string {
  return safeErrorMessage(error, fallback);
}

export function normalizeGitPath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

export function isSafeGitRelativePath(value: string): boolean {
  if (value.trim().length === 0 || value.includes("\0")) {
    return false;
  }
  const normalized = normalizeGitPath(value);
  return (
    !normalized.startsWith("/") &&
    !/^[a-z]:\//iu.test(normalized) &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    !normalized.split("/").includes("..")
  );
}
