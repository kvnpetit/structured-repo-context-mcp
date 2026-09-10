import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { startClient } from "./client";
import { resolveLspCommand } from "./launcher";

const directories: string[] = [];

function fixture(local = false): {
  root: string;
  bin: string;
  packageRoot: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "src-lsp-launcher-"));
  directories.push(root);
  const bin = local ? path.join(root, "node_modules", ".bin") : root;
  const packageRoot = path.join(
    root,
    "node_modules",
    "typescript-language-server",
  );
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "typescript-language-server",
      bin: { "typescript-language-server": "server.cjs" },
    }),
  );
  return { root, bin, packageRoot };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("local npm language server launcher", () => {
  test("preserves native executables before npm shims in PATH order", () => {
    const { root, bin } = fixture();
    const native = path.join(bin, "pyright-langserver.exe");
    fs.writeFileSync(native, "native executable fixture");
    expect(
      resolveLspCommand(
        { command: "pyright-langserver", args: ["--stdio"] },
        { PATH: root },
        "win32",
      ),
    ).toEqual({ command: native, args: ["--stdio"] });
  });
  test.each([false, true])(
    "resolves JS without executing the global/local cmd shim: local=%s",
    (local) => {
      const { bin, packageRoot } = fixture(local);
      fs.writeFileSync(path.join(packageRoot, "server.cjs"), "// fixture");
      fs.writeFileSync(
        path.join(bin, "typescript-language-server.cmd"),
        "this shim must never execute",
      );
      const command = resolveLspCommand(
        { command: "typescript-language-server.cmd", args: ["--stdio"] },
        { PATH: bin },
        "win32",
      );
      expect(command).toEqual({
        command: process.execPath,
        args: [path.join(packageRoot, "server.cjs"), "--stdio"],
      });
    },
  );

  test("rejects a package entry escaping its directory", () => {
    const { bin, packageRoot } = fixture();
    fs.writeFileSync(path.join(packageRoot, "..", "escape.cjs"), "// fixture");
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "typescript-language-server",
        bin: "../escape.cjs",
      }),
    );
    expect(() =>
      resolveLspCommand(
        { command: "typescript-language-server", args: [] },
        { PATH: bin },
        "win32",
      ),
    ).toThrow("not installed");
  });

  test("runs initialize, hover, timeout and shutdown over a real local process", async () => {
    const { root, bin, packageRoot } = fixture();
    const server = path.join(packageRoot, "server.cjs");
    fs.writeFileSync(
      server,
      `
let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0,end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const value = JSON.parse(buffer.subarray(end+4,end+4+length).toString());
    buffer = buffer.subarray(end+4+length);
    if (value.method === 'exit') process.exit(0);
    if (value.id === undefined || value.method === 'fixture/timeout') continue;
    const result = value.method === 'textDocument/hover' ? { contents: 'Local hover proof' } : {};
    const body = JSON.stringify({jsonrpc:'2.0',id:value.id,result});
    process.stdout.write('Content-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body);
  }
});`,
    );
    const resolved = resolveLspCommand(
      { command: "typescript-language-server.cmd", args: ["--stdio"] },
      { PATH: bin },
      "win32",
    );
    // On Windows exercise startClient's resolution too; elsewhere prove the
    // exact resolved command over a real JSON-RPC subprocess.
    const descriptor =
      process.platform === "win32"
        ? {
            command: path.join(bin, "typescript-language-server.cmd"),
            args: ["--stdio"],
          }
        : resolved;
    const client = await startClient(root, descriptor, 3000);
    try {
      await expect(
        client.request("textDocument/hover", {}, 3000),
      ).resolves.toEqual({ contents: "Local hover proof" });
      const controller = new AbortController();
      await expect(
        client.request("fixture/timeout", {}, 30, controller.signal),
      ).rejects.toThrow("timed out");
      await expect(
        client.request("textDocument/hover", {}, 3000),
      ).resolves.toEqual({ contents: "Local hover proof" });
    } finally {
      await client.close();
    }
    expect(client.isClosed()).toBe(true);
  });
});
