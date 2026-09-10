import { pathToFileURL } from "node:url";

import type { JsonRpcClient } from "./client";
import {
  isRecord,
  parseDiagnostics,
  parseHover,
  parseLocations,
  parseTypeHierarchyItems,
} from "./protocol";
import { candidateFor, normalizeLanguage } from "./servers";
import { acquireLspSession, syncLspDocument, type LspSessionLease } from "./sessions";
import type { LspAttempt, LspLocation, LspOperation, LspRequestOptions } from "./types";

const REQUEST_METHODS: Partial<Record<LspOperation, string>> = {
  definition: "textDocument/definition",
  references: "textDocument/references",
  implementation: "textDocument/implementation",
  hover: "textDocument/hover",
  diagnostics: "textDocument/diagnostic",
};

function positionCharacter(content: string, line: number, column: number): number {
  const lines = content.split("\n");
  const text = (lines[line] ?? "").replace(/\r$/u, "");
  const codePoints = Array.from(text);
  return Array.from(codePoints.slice(0, Math.max(0, column))).join("").length;
}

function operationParams(options: LspRequestOptions, uri: string): Record<string, unknown> {
  const line = Math.max(0, options.line - 1);
  const character = positionCharacter(options.content, line, options.column);
  return {
    textDocument: { uri },
    position: { line, character },
    ...(options.operation === "references" ? { context: { includeDeclaration: true } } : {}),
  };
}

async function requestTypeHierarchy(
  client: JsonRpcClient,
  options: LspRequestOptions,
  uri: string,
): Promise<LspLocation[]> {
  const prepared = await client.request(
    "textDocument/prepareTypeHierarchy",
    operationParams(options, uri),
    options.timeoutMs,
    options.signal,
  );
  const items = Array.isArray(prepared) ? prepared.filter(isRecord).slice(0, 20) : [];
  const locations = parseTypeHierarchyItems(items);
  for (const item of items) {
    const [supertypes, subtypes] = await Promise.all([
      client.request("typeHierarchy/supertypes", { item }, options.timeoutMs, options.signal),
      client.request("typeHierarchy/subtypes", { item }, options.timeoutMs, options.signal),
    ]);
    locations.push(...parseTypeHierarchyItems(supertypes));
    locations.push(...parseTypeHierarchyItems(subtypes));
    if (locations.length >= 200) {
      break;
    }
  }
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.uri}:${String(location.range.start.line)}:${String(location.range.start.character)}:${String(location.range.end.line)}:${String(location.range.end.character)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function asDetail(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message.slice(0, 200);
  }
  return "Local language server request failed";
}

export async function requestLsp(options: LspRequestOptions): Promise<LspAttempt> {
  if (process.env.SRC_LSP_ENABLED === "false") {
    return {
      ok: false,
      reason: "disabled",
      detail: "Local LSP is disabled by SRC_LSP_ENABLED",
    };
  }
  const normalizedLanguage = normalizeLanguage(options.language);
  const candidate = candidateFor(normalizedLanguage);
  if (candidate === undefined) {
    return {
      ok: false,
      reason: "unsupported_language",
      detail: `No allow-listed local LSP is configured for ${normalizedLanguage}`,
    };
  }

  let lastError = "No allow-listed local language server was found";
  for (const descriptor of candidate.commands) {
    let lease: LspSessionLease | undefined;
    let discardSession = false;
    try {
      lease = await acquireLspSession(options.root, descriptor, options.timeoutMs);
      const client = lease.client;
      const uri = pathToFileURL(options.filePath).toString();
      syncLspDocument(lease.session, client, options, uri);
      if (options.operation === "type_hierarchy") {
        const locations = await requestTypeHierarchy(client, options, uri);
        return {
          ok: true,
          result: {
            kind: "locations",
            locations,
            server: {
              id: candidate.id,
              command: descriptor.command,
              args: descriptor.args,
            },
          },
        };
      }
      const method = REQUEST_METHODS[options.operation];
      if (method === undefined) {
        throw new Error("Unsupported local LSP operation");
      }
      let response: unknown;
      try {
        response = await client.request(
          method,
          operationParams(options, uri),
          options.timeoutMs,
          options.signal,
        );
      } catch (error) {
        if (options.operation !== "diagnostics") {
          throw error;
        }
        const pushed = client.publishedDiagnosticsFor(uri);
        if (pushed === undefined) {
          throw error;
        }
        response = pushed;
      }
      if (options.operation === "hover") {
        return {
          ok: true,
          result: {
            kind: "hover",
            hover: parseHover(response),
            server: {
              id: candidate.id,
              command: descriptor.command,
              args: descriptor.args,
            },
          },
        };
      }
      if (options.operation === "diagnostics") {
        return {
          ok: true,
          result: {
            kind: "diagnostics",
            diagnostics: parseDiagnostics(response),
            server: {
              id: candidate.id,
              command: descriptor.command,
              args: descriptor.args,
            },
          },
        };
      }
      return {
        ok: true,
        result: {
          kind: "locations",
          locations: parseLocations(response),
          server: {
            id: candidate.id,
            command: descriptor.command,
            args: descriptor.args,
          },
        },
      };
    } catch (error) {
      discardSession = true;
      lastError = asDetail(error);
    } finally {
      try {
        await lease?.release(discardSession);
      } catch {
        // Do not mask the useful navigation failure with a shutdown error.
      }
    }
  }

  return {
    ok: false,
    reason: lastError.includes("timed out") ? "request_failed" : "server_unavailable",
    detail: lastError,
  };
}
