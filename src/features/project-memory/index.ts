import * as crypto from "node:crypto";

import {
  createPaginationCursor,
  createPaginationScope,
  decodePaginationCursor,
} from "@core/pagination";
import { redactSourceText, resolveSecureDirectory } from "@core/security";
import {
  LOCAL_STATE_VERSION,
  localStateRelativePath,
  readLocalState,
  withLocalStateLock,
  writeLocalState,
} from "@core/local-state";
import type { Feature, FeatureResult } from "@features/types";
import {
  getProjectMemoryOutputSchema,
  getProjectMemorySchema,
  MAX_MEMORY_RECORDS,
  MEMORY_FILE,
  memoryStoreSchema,
  setProjectMemoryOutputSchema,
  setProjectMemorySchema,
  type GetProjectMemoryInput,
  type MemoryLink,
  type MemoryRecord,
  type MemoryStore,
  type RevisionState,
  type SetProjectMemoryInput,
} from "./schema";
import {
  canonicalGitRevision,
  currentGitRevision,
  revisionState,
} from "./revision";

export {
  getProjectMemoryOutputSchema,
  getProjectMemorySchema,
  setProjectMemoryOutputSchema,
  setProjectMemorySchema,
  type GetProjectMemoryInput,
  type SetProjectMemoryInput,
} from "./schema";

type MemoryRecordView = MemoryRecord & { revision_state: RevisionState };

function recordsInScope(
  records: readonly MemoryRecord[],
  scope: string,
): number {
  return records.filter((record) => record.scope === scope).length;
}

function emptyStore(): MemoryStore {
  return {
    version: LOCAL_STATE_VERSION,
    updated_at: new Date(0).toISOString(),
    records: [],
  };
}

function loadStore(
  root: string,
):
  | { ok: true; exists: boolean; store: MemoryStore }
  | { ok: false; error: string } {
  const result = readLocalState(root, MEMORY_FILE);
  if (!result.ok) {
    return result;
  }
  if (!result.exists || result.value === undefined) {
    return { ok: true, exists: false, store: emptyStore() };
  }
  const parsed = memoryStoreSchema.safeParse(result.value);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Project memory is corrupt or has an unsupported version",
    };
  }
  return { ok: true, exists: true, store: parsed.data };
}

function storeRevision(store: MemoryStore): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(store), "utf8")
    .digest("hex");
}

function termsFor(value: string): string[] {
  return (
    value
      .toLowerCase()
      .match(/[a-z0-9_$.-]+/gu)
      ?.filter((term, index, all) => all.indexOf(term) === index)
      .slice(0, 30) ?? []
  );
}

function isExpired(record: MemoryRecord, now = Date.now()): boolean {
  return (
    record.expires_at !== undefined &&
    Number.isFinite(Date.parse(record.expires_at)) &&
    Date.parse(record.expires_at) <= now
  );
}

function memoryScore(
  record: MemoryRecord,
  terms: readonly string[],
  query: string,
  mode: "hybrid" | "lexical",
): number {
  if (terms.length === 0) {
    return 0;
  }
  const title = record.title.toLowerCase();
  const body = record.body.toLowerCase();
  const tags = record.tags.join(" ").toLowerCase();
  const links = record.links
    .map((link) => link.target)
    .join(" ")
    .toLowerCase();
  const lexicalScore = terms.reduce((score, term) => {
    return (
      score +
      (title.includes(term) ? 5 : 0) +
      (tags.includes(term) ? 3 : 0) +
      (links.includes(term) ? 2 : 0) +
      (body.includes(term) ? 1 : 0)
    );
  }, 0);
  if (mode === "lexical" || query.trim().length === 0) {
    return lexicalScore;
  }
  const normalizedQuery = query.trim().toLowerCase();
  const searchable = `${title}\n${body}\n${tags}\n${links}`;
  return lexicalScore + (searchable.includes(normalizedQuery) ? 8 : 0);
}

function redactRecord(
  record: MemoryRecord,
  enabled: boolean,
): {
  record: MemoryRecord;
  redacted: boolean;
} {
  if (!enabled) {
    return { record, redacted: false };
  }
  let redacted = false;
  const redact = (value: string): string => {
    const result = redactSourceText(value);
    redacted ||= result.redacted;
    return result.text;
  };
  const links = record.links.map((link) => ({
    ...link,
    target: redact(link.target),
  }));
  return {
    record: {
      ...record,
      title: redact(record.title),
      body: redact(record.body),
      tags: record.tags.map(redact),
      links,
    },
    redacted,
  };
}

function normalizeTags(tags: readonly string[]): string[] {
  return [
    ...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)),
  ].slice(0, 16);
}

function normalizeLinks(links: readonly MemoryLink[]): MemoryLink[] {
  const seen = new Set<string>();
  const normalized: MemoryLink[] = [];
  for (const link of links) {
    const target = link.target.trim();
    const key = `${link.kind}:${target}`;
    if (target.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({ kind: link.kind, target });
    if (normalized.length >= 20) {
      break;
    }
  }
  return normalized;
}

function conflictResult(message: string): FeatureResult {
  return { success: false, error: message };
}

export async function executeGetProjectMemory(
  rawInput: GetProjectMemoryInput,
): Promise<FeatureResult> {
  const input = getProjectMemorySchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }
  const root = secureDirectory.path;
  const loaded = loadStore(root);
  if (!loaded.ok) {
    return { success: false, error: loaded.error };
  }
  const currentRevision = await currentGitRevision(root);

  const queryTerms = termsFor(input.query);
  const requestedTags = normalizeTags(input.tags);
  const scope = createPaginationScope({
    directory: root,
    memory_scope: input.scope,
    query: input.query,
    search_mode: input.search_mode,
    kind: input.kind ?? null,
    tags: requestedTags,
    include_expired: input.include_expired,
    min_confidence: input.min_confidence,
    current_revision: currentRevision ?? null,
    store_revision: storeRevision(loaded.store),
  });
  const cursor = decodePaginationCursor(input.cursor, scope);
  if (!cursor.ok) {
    return { success: false, error: cursor.error };
  }

  const candidates = loaded.store.records
    .filter((record) => record.scope === input.scope)
    .filter((record) => input.kind === undefined || record.kind === input.kind)
    .filter((record) => requestedTags.every((tag) => record.tags.includes(tag)))
    .filter((record) => input.include_expired || !isExpired(record))
    .filter((record) => record.confidence >= input.min_confidence)
    .map((record) => ({
      record,
      score: memoryScore(record, queryTerms, input.query, input.search_mode),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.record.confidence - left.record.confidence ||
        right.record.updated_at.localeCompare(left.record.updated_at) ||
        left.record.id.localeCompare(right.record.id),
    );
  const page = candidates.slice(cursor.offset, cursor.offset + input.limit);
  const truncated = cursor.offset + page.length < candidates.length;
  const nextCursor = truncated
    ? createPaginationCursor(scope, cursor.offset + page.length)
    : undefined;
  let secretsRedacted = false;
  const records: MemoryRecordView[] = page.map(({ record }) => {
    const redacted = redactRecord(record, input.redact_secrets);
    secretsRedacted ||= redacted.redacted;
    return {
      ...redacted.record,
      revision_state: revisionState(record, currentRevision),
    };
  });
  const revisionSummary = records.reduce(
    (summary, record) => {
      summary[record.revision_state] += 1;
      return summary;
    },
    { current: 0, stale: 0, unknown: 0 },
  );

  const data = {
    directory: root,
    scope: input.scope,
    memory_file: localStateRelativePath(MEMORY_FILE),
    state: loaded.exists ? ("ready" as const) : ("missing" as const),
    query: input.query,
    search_mode: input.search_mode,
    records_total: candidates.length,
    records_returned: records.length,
    cursor_offset: cursor.offset,
    ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
    truncated,
    source_is_untrusted: true as const,
    secrets_redacted: secretsRedacted,
    store_revision: storeRevision(loaded.store),
    ...(currentRevision === undefined
      ? {}
      : { current_revision: currentRevision }),
    revision_summary: revisionSummary,
    records,
    errors: [],
  };
  return {
    success: true,
    message: `Project memory: ${String(records.length)} record${records.length === 1 ? "" : "s"}${truncated ? " (truncated)" : ""}`,
    data,
  };
}

export async function executeSetProjectMemory(
  rawInput: SetProjectMemoryInput,
): Promise<FeatureResult> {
  const input = setProjectMemorySchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }
  const root = secureDirectory.path;
  const resolvedRevision =
    input.operation !== "upsert"
      ? undefined
      : input.source_revision !== undefined
        ? ((await canonicalGitRevision(root, input.source_revision)) ??
          input.source_revision)
        : input.capture_source_revision
          ? await currentGitRevision(root)
          : undefined;
  return withLocalStateLock(root, MEMORY_FILE, () => {
    const loaded = loadStore(root);
    if (!loaded.ok) {
      return { success: false, error: loaded.error };
    }
    const now = new Date().toISOString();
    const records = [...loaded.store.records];
    const index = records.findIndex(
      (record) => record.id === input.id && record.scope === input.scope,
    );
    const existing = index >= 0 ? records[index] : undefined;

    if (input.expected_updated_at !== undefined) {
      if (existing?.updated_at !== input.expected_updated_at) {
        return conflictResult(
          "Project memory changed since the supplied expected_updated_at",
        );
      }
    }

    if (input.operation === "delete") {
      if (existing === undefined) {
        return {
          success: true,
          message: `Project memory record ${input.id} was already absent`,
          data: {
            directory: root,
            scope: input.scope,
            memory_file: localStateRelativePath(MEMORY_FILE),
            operation: "delete" as const,
            id: input.id,
            deleted: false,
            records_count: recordsInScope(records, input.scope),
            store_revision: storeRevision(loaded.store),
            source_is_untrusted: true as const,
            secrets_redacted: false,
          },
        };
      }
      records.splice(index, 1);
      const store: MemoryStore = {
        version: LOCAL_STATE_VERSION,
        updated_at: now,
        records,
      };
      writeLocalState(root, MEMORY_FILE, store);
      return {
        success: true,
        message: `Deleted project memory record ${input.id}`,
        data: {
          directory: root,
          scope: input.scope,
          memory_file: localStateRelativePath(MEMORY_FILE),
          operation: "delete" as const,
          id: input.id,
          deleted: true,
          records_count: recordsInScope(records, input.scope),
          store_revision: storeRevision(store),
          source_is_untrusted: true as const,
          secrets_redacted: false,
        },
      };
    }

    if (existing === undefined && records.length >= MAX_MEMORY_RECORDS) {
      return {
        success: false,
        error: `Project memory reached its ${String(MAX_MEMORY_RECORDS)}-record limit`,
      };
    }
    const title = input.redact_secrets
      ? redactSourceText(input.title).text
      : input.title;
    const body = input.redact_secrets
      ? redactSourceText(input.body).text
      : input.body;
    const tags = normalizeTags(input.tags).map((tag) =>
      input.redact_secrets ? redactSourceText(tag).text : tag,
    );
    const links = normalizeLinks(input.links).map((link) => ({
      ...link,
      target: input.redact_secrets
        ? redactSourceText(link.target).text
        : link.target,
    }));
    const record: MemoryRecord = {
      id: input.id,
      scope: input.scope,
      kind: input.kind,
      title,
      body,
      tags,
      links,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      ...(resolvedRevision === undefined
        ? {}
        : { source_revision: resolvedRevision }),
      ...(input.expires_at === undefined
        ? {}
        : { expires_at: input.expires_at }),
      confidence: input.confidence,
    };
    if (index >= 0) {
      records[index] = record;
    } else {
      records.push(record);
    }
    const store: MemoryStore = {
      version: LOCAL_STATE_VERSION,
      updated_at: now,
      records,
    };
    writeLocalState(root, MEMORY_FILE, store);
    const redactedRecord = redactRecord(record, input.redact_secrets);
    return {
      success: true,
      message: `${existing === undefined ? "Created" : "Updated"} project memory record ${input.id}`,
      data: {
        directory: root,
        scope: input.scope,
        memory_file: localStateRelativePath(MEMORY_FILE),
        operation: "upsert" as const,
        id: input.id,
        record: redactedRecord.record,
        records_count: recordsInScope(records, input.scope),
        store_revision: storeRevision(store),
        source_is_untrusted: true as const,
        secrets_redacted: input.redact_secrets,
      },
    };
  });
}

export const getProjectMemoryFeature: Feature<typeof getProjectMemorySchema> = {
  name: "get_project_memory",
  title: "Get project memory",
  description:
    "Read bounded, project-isolated local memory containing decisions, constraints, facts, todos, and notes. It never calls a remote service and marks all stored content as untrusted data.",
  schema: getProjectMemorySchema,
  outputSchema: getProjectMemoryOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execute: executeGetProjectMemory,
};

export const setProjectMemoryFeature: Feature<typeof setProjectMemorySchema> = {
  name: "set_project_memory",
  title: "Set project memory",
  description:
    "Create, update, or delete one bounded record in the isolated local project memory. Writes are atomic, optimistic-concurrency aware, secret-redacted by default, and never execute project content.",
  schema: setProjectMemorySchema,
  outputSchema: setProjectMemoryOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  execute: executeSetProjectMemory,
};
