import { startClient, type JsonRpcClient } from "./client";
import { languageId } from "./servers";
import type { LspRequestOptions } from "./types";

const MAX_LSP_SESSIONS = 8;
const MAX_OPEN_DOCUMENTS_PER_SESSION = 128;
const DEFAULT_LSP_IDLE_MS = 15_000;
const MAX_LSP_IDLE_MS = 10 * 60_000;

export interface CachedLspSession {
  key: string;
  client: JsonRpcClient;
  documents: Map<string, { content: string; version: number }>;
  inFlight: number;
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
}

export interface LspSessionLease {
  client: JsonRpcClient;
  session?: CachedLspSession;
  release: (discard?: boolean) => Promise<void>;
}

const lspSessions = new Map<string, CachedLspSession>();
const lspSessionStarts = new Map<string, Promise<CachedLspSession>>();

function sessionCacheEnabled(): boolean {
  return process.env.SRC_LSP_SESSION_CACHE !== "false";
}

function sessionIdleMs(): number {
  const parsed = Number(process.env.SRC_LSP_IDLE_MS);
  return Number.isSafeInteger(parsed) && parsed >= 1_000
    ? Math.min(parsed, MAX_LSP_IDLE_MS)
    : DEFAULT_LSP_IDLE_MS;
}

function sessionKey(
  root: string,
  descriptor: { command: string; args: readonly string[] },
): string {
  return `${root}\0${descriptor.command}\0${descriptor.args.join("\0")}`;
}

async function discardLspSession(session: CachedLspSession): Promise<void> {
  if (session.idleTimer !== undefined) {
    clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
  }
  if (lspSessions.get(session.key) === session) {
    lspSessions.delete(session.key);
  }
  await session.client.close();
}

function scheduleLspSessionClose(session: CachedLspSession): void {
  if (session.idleTimer !== undefined) {
    clearTimeout(session.idleTimer);
  }
  const timer = setTimeout(() => {
    if (
      session.inFlight === 0 &&
      lspSessions.get(session.key) === session &&
      Date.now() - session.lastUsedAt >= sessionIdleMs()
    ) {
      void discardLspSession(session);
    } else if (lspSessions.get(session.key) === session) {
      scheduleLspSessionClose(session);
    }
  }, sessionIdleMs());
  timer.unref();
  session.idleTimer = timer;
}

function trimLspSessions(): void {
  while (lspSessions.size > MAX_LSP_SESSIONS) {
    const oldest = Array.from(lspSessions.values())
      .filter((session) => session.inFlight === 0)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (oldest === undefined) {
      return;
    }
    void discardLspSession(oldest);
  }
}

export async function acquireLspSession(
  root: string,
  descriptor: { command: string; args: string[] },
  timeoutMs: number,
): Promise<LspSessionLease> {
  if (!sessionCacheEnabled()) {
    const client = await startClient(root, descriptor, timeoutMs);
    let released = false;
    return {
      client,
      release: async () => {
        if (!released) {
          released = true;
          await client.close();
        }
      },
    };
  }

  const key = sessionKey(root, descriptor);
  let session = lspSessions.get(key);
  if (session === undefined || session.client.isClosed()) {
    if (session !== undefined) {
      await discardLspSession(session);
    }
    let starting = lspSessionStarts.get(key);
    if (starting === undefined) {
      starting = (async () => ({
        key,
        client: await startClient(root, descriptor, timeoutMs),
        documents: new Map<string, { content: string; version: number }>(),
        inFlight: 0,
        lastUsedAt: Date.now(),
      }))();
      lspSessionStarts.set(key, starting);
    }
    try {
      session = await starting;
      if (lspSessions.get(key) === undefined) {
        lspSessions.set(key, session);
      }
    } finally {
      if (lspSessionStarts.get(key) === starting) {
        lspSessionStarts.delete(key);
      }
    }
  }

  session.inFlight += 1;
  session.lastUsedAt = Date.now();
  if (session.idleTimer !== undefined) {
    clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
  }
  trimLspSessions();
  let released = false;
  return {
    client: session.client,
    session,
    release: async (discard = false) => {
      if (released) {
        return;
      }
      released = true;
      session.inFlight = Math.max(0, session.inFlight - 1);
      session.lastUsedAt = Date.now();
      if (discard || session.client.isClosed()) {
        await discardLspSession(session);
      } else {
        scheduleLspSessionClose(session);
        trimLspSessions();
      }
    },
  };
}

export function syncLspDocument(
  session: CachedLspSession | undefined,
  client: JsonRpcClient,
  options: LspRequestOptions,
  uri: string,
): void {
  if (session === undefined) {
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: languageId(options.filePath, options.language),
        version: 1,
        text: options.content,
      },
    });
    return;
  }

  const previous = session.documents.get(uri);
  if (previous === undefined) {
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: languageId(options.filePath, options.language),
        version: 1,
        text: options.content,
      },
    });
    session.documents.set(uri, { content: options.content, version: 1 });
  } else if (previous.content !== options.content) {
    const version = previous.version + 1;
    client.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: options.content }],
    });
    session.documents.set(uri, { content: options.content, version });
  }

  while (session.documents.size > MAX_OPEN_DOCUMENTS_PER_SESSION) {
    const first = session.documents.keys().next().value;
    if (first === undefined || first === uri) {
      break;
    }
    client.notify("textDocument/didClose", { textDocument: { uri: first } });
    session.documents.delete(first);
  }
}

/** Close all cached local language-server sessions. Useful for embedding SRC in a host process. */
export async function closeLspSessions(): Promise<void> {
  const sessions = Array.from(lspSessions.values());
  lspSessions.clear();
  await Promise.all(
    sessions.map(async (session) => {
      await session.client.close();
    }),
  );
}
