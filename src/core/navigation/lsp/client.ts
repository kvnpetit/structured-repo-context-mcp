import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { createSafeLocalToolEnvironment } from "@core/security";

import {
  isRecord,
  jsonRpcMessage,
  MAX_LSP_BUFFER_BYTES,
  parseLspFrames,
} from "./protocol";

export class JsonRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;

  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  private readonly closePromise: Promise<void>;

  private readonly publishedDiagnostics = new Map<string, unknown>();

  private buffer: Buffer = Buffer.alloc(0);

  private nextId = 1;

  private closed = false;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.closePromise = new Promise((resolve) => {
      child.once("close", () => {
        this.closed = true;
        this.buffer = Buffer.alloc(0);
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Language server closed"));
        }
        this.pending.clear();
        resolve();
      });
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      const incoming = Buffer.from(chunk);
      if (this.buffer.byteLength + incoming.byteLength > MAX_LSP_BUFFER_BYTES) {
        this.fail(
          new Error(
            "Language server receive buffer exceeds the local size limit",
          ),
        );
        return;
      }
      this.buffer = Buffer.concat([this.buffer, incoming]);
      const parsed = parseLspFrames(this.buffer);
      this.buffer = parsed.remainder;
      for (const body of parsed.messages) {
        try {
          const value: unknown = JSON.parse(body.toString("utf8"));
          this.handleMessage(value);
        } catch {
          // Ignore malformed server messages and keep the framing stream alive.
        }
      }
      if (parsed.error !== undefined) {
        this.fail(new Error(parsed.error));
      }
    });
    child.stderr.on("data", () => {
      // Drain diagnostics so a noisy local server cannot block on stderr.
    });
    child.on("error", (error) => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  isClosed(): boolean {
    return this.closed;
  }

  private fail(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    try {
      this.child.kill();
    } catch {
      // The child may already have exited while the stream was being drained.
    }
  }

  private handleMessage(value: unknown): void {
    if (!isRecord(value)) {
      return;
    }
    const id = value.id;
    if (typeof id === "number") {
      const pending = this.pending.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if ("error" in value && isRecord(value.error)) {
          pending.reject(
            new Error(
              typeof value.error.message === "string"
                ? value.error.message
                : "Language server request failed",
            ),
          );
        } else {
          pending.resolve(value.result);
        }
        return;
      }
    }
    if (
      typeof value.method === "string" &&
      value.method === "textDocument/publishDiagnostics" &&
      isRecord(value.params) &&
      typeof value.params.uri === "string"
    ) {
      this.publishedDiagnostics.set(value.params.uri, value.params.diagnostics);
      return;
    }
    if (id !== undefined && typeof value.method === "string") {
      this.respondToServerRequest(id, value.method);
    }
  }

  publishedDiagnosticsFor(uri: string): unknown {
    return this.publishedDiagnostics.get(uri);
  }

  private respondToServerRequest(id: unknown, method: string): void {
    let result: unknown = null;
    if (method === "workspace/workspaceFolders") {
      result = [];
    } else if (method === "workspace/configuration") {
      result = [];
    } else if (method === "window/workDoneProgress/create") {
      result = null;
    }
    if (!this.closed && this.child.stdin.writable) {
      this.child.stdin.write(jsonRpcMessage({ jsonrpc: "2.0", id, result }));
    }
  }

  notify(method: string, params: unknown): void {
    if (this.closed || !this.child.stdin.writable) {
      return;
    }
    this.child.stdin.write(jsonRpcMessage({ jsonrpc: "2.0", method, params }));
  }

  async request(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed || !this.child.stdin.writable) {
      return Promise.reject(new Error("Language server is not available"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Language server request timed out: ${method}`));
      }, timeoutMs);
      const abort = (): void => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Language server request cancelled"));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
        timer,
      });
      try {
        this.child.stdin.write(
          jsonRpcMessage({ jsonrpc: "2.0", id, method, params }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(
          error instanceof Error
            ? error
            : new Error("Language server write failed"),
        );
      }
    });
  }

  async close(): Promise<void> {
    if (!this.closed) {
      try {
        await this.request("shutdown", null, 1_000);
      } catch {
        // A server that cannot shut down gracefully is still terminated below.
      }
      this.notify("exit", null);
      this.child.stdin.end();
      const forced = setTimeout(() => {
        if (!this.closed) {
          this.child.kill();
        }
      }, 1_000);
      await this.closePromise;
      clearTimeout(forced);
    }
  }
}

export async function startClient(
  root: string,
  descriptor: { command: string; args: string[] },
  timeoutMs: number,
): Promise<JsonRpcClient> {
  const child = spawn(descriptor.command, descriptor.args, {
    cwd: root,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: createSafeLocalToolEnvironment(),
  });
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  let spawnTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      spawned,
      new Promise<never>((_, reject) => {
        spawnTimer = setTimeout(() => {
          reject(new Error("Language server did not start"));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    if (spawnTimer !== undefined) {
      clearTimeout(spawnTimer);
    }
  }
  const client = new JsonRpcClient(child);
  const rootUri = pathToFileURL(root).toString();
  try {
    await client.request(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: "src-mcp", version: "1.0.3" },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
        capabilities: {
          workspace: { workspaceFolders: true, configuration: false },
          textDocument: {
            definition: { linkSupport: true },
            references: {},
            implementation: { linkSupport: true },
            typeHierarchy: {},
            diagnostic: { dynamicRegistration: false },
            hover: { contentFormat: ["markdown", "plaintext"] },
          },
        },
        initializationOptions: {},
      },
      timeoutMs,
    );
    client.notify("initialized", {});
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
