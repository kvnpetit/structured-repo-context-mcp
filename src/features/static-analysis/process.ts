import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { createSafeLocalToolEnvironment } from "@core/security";
import { truncateUtf8 } from "@core/utils/utf8";

import type { StaticBackend } from "./schema";
import type { ProcessResult } from "./types";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const COMMANDS: Record<StaticBackend, readonly string[]> = {
  "ast-grep": ["ast-grep", "sg"],
  semgrep: ["semgrep"],
  codeql: ["codeql"],
};

function appendBounded(current: string, chunk: string): { value: string; truncated: boolean } {
  const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) {
    return { value: current, truncated: true };
  }
  if (Buffer.byteLength(chunk, "utf8") <= remaining) {
    return { value: current + chunk, truncated: false };
  }
  return { value: current + truncateUtf8(chunk, remaining), truncated: true };
}

export async function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(command, [...args], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: createSafeLocalToolEnvironment(),
      });
    } catch {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        timedOut: false,
        spawnError: "Unable to start local analyzer",
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const abort = (): void => {
      if (!settled) {
        child.kill();
      }
    };
    const finish = (result: ProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    child.stdout.on("data", (chunk: Buffer | string) => {
      const appended = appendBounded(stdout, chunk.toString());
      stdout = appended.value;
      outputTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const appended = appendBounded(stderr, chunk.toString());
      stderr = appended.value;
      outputTruncated ||= appended.truncated;
    });
    child.once("error", (error: Error & { code?: string }) => {
      finish({
        exitCode: null,
        stdout,
        stderr,
        outputTruncated,
        timedOut,
        spawnError:
          error.code === "ENOENT"
            ? "Local analyzer executable was not found"
            : "Unable to start local analyzer",
      });
    });
    child.once("close", (exitCode) => {
      finish({ exitCode, stdout, stderr, outputTruncated, timedOut });
    });
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }
  });
}

export async function findExecutable(
  backend: StaticBackend,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ command?: string; probe?: ProcessResult }> {
  for (const command of COMMANDS[backend]) {
    const probe = await runProcess(command, ["--version"], cwd, timeoutMs, signal);
    if (probe.spawnError === undefined) {
      return { command, probe };
    }
  }
  return {};
}
