import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  detectNavigationLanguage,
  lspLocationPath,
  lspPositionToUtf8Offset,
  parseLspFrames,
  requestLsp,
} from "@core/navigation/lsp";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("local LSP navigation helpers", () => {
  test("parses fragmented frames and retains an incomplete remainder", () => {
    const body = Buffer.from('{"jsonrpc":"2.0","id":1,"result":null}', "utf8");
    const frame = Buffer.concat([
      Buffer.from(
        `Content-Length: ${String(body.byteLength)}\r\n\r\n`,
        "ascii",
      ),
      body,
    ]);
    const first = parseLspFrames(frame.subarray(0, 9));
    expect(first.messages).toHaveLength(0);
    expect(first.remainder).toEqual(frame.subarray(0, 9));

    const second = parseLspFrames(
      Buffer.concat([first.remainder, frame.subarray(9)]),
    );
    expect(second.error).toBeUndefined();
    expect(second.messages.map((message) => message.toString("utf8"))).toEqual([
      body.toString("utf8"),
    ]);
    expect(second.remainder).toHaveLength(0);
  });

  test("rejects oversized LSP headers and declared message bodies", () => {
    const oversizedHeader = parseLspFrames(Buffer.alloc(16 * 1024 + 1, 0x61));
    expect(oversizedHeader.error).toMatch(/header exceeds/u);

    const oversizedBody = parseLspFrames(
      Buffer.from("Content-Length: 8388609\r\n\r\n", "ascii"),
    );
    expect(oversizedBody.error).toMatch(/message exceeds/u);
  });

  test("converts UTF-16 LSP positions to UTF-8 offsets", () => {
    const content = "const café = '😀';\n";
    const offset = lspPositionToUtf8Offset(content, {
      line: 0,
      character: "const café = '😀'".length,
    });

    expect(offset).toBe(Buffer.byteLength("const café = '😀'", "utf8"));
  });

  test("keeps LSP locations inside the configured project root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-lsp-root-"));
    temporaryDirectories.push(root);
    const file = path.join(root, "module.ts");
    fs.writeFileSync(file, "export const value = 1;\n");

    expect(lspLocationPath(pathToFileURL(file).toString(), root)).toBe(file);
    expect(
      lspLocationPath(
        pathToFileURL(path.join(os.tmpdir(), "outside.ts")).toString(),
        root,
      ),
    ).toBeUndefined();
  });

  test("detects the configured language from a source file", () => {
    expect(detectNavigationLanguage("module.ts")).toBe("typescript");
    expect(detectNavigationLanguage("module.py")).toBe("python");
  });

  test("honors the local-only disable switch without spawning a process", async () => {
    vi.stubEnv("SRC_LSP_ENABLED", "false");
    const result = await requestLsp({
      root: process.cwd(),
      filePath: path.join(process.cwd(), "module.ts"),
      content: "const value = 1;\n",
      language: "typescript",
      line: 1,
      column: 6,
      operation: "definition",
      timeoutMs: 100,
    });

    expect(result).toEqual({
      ok: false,
      reason: "disabled",
      detail: "Local LSP is disabled by SRC_LSP_ENABLED",
    });
  });
});
