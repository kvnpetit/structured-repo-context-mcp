import * as crypto from "node:crypto";
import * as path from "node:path";

import { z } from "zod";

import {
  createPaginationCursor,
  createPaginationScope,
  decodePaginationCursor,
} from "@core/pagination";
import {
  redactSourceText,
  readSecureTextFile,
  resolveSecureDirectory,
} from "@core/security";
import {
  LOCAL_STATE_VERSION,
  localStateRelativePath,
  readLocalState,
  withLocalStateLock,
  writeLocalState,
} from "@core/local-state";
import { truncateUtf8WithStatus } from "@core/utils/utf8";
import type { Feature, FeatureResult } from "@features/types";
import { createFeatureResultSchema } from "@features/utils";
import {
  projectArtifactsFeature,
  type ProjectArtifact,
  type ProjectArtifactsOutput,
} from "@features/project-artifacts";
import { artifactScore, queryTerms } from "./ranking";

const CATALOG_FILE = "artifacts-catalog.json";
const DEFAULT_CATALOG_SCOPE = "project";
const catalogScopeSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/iu)
  .describe(
    "Local catalog namespace; it never crosses the selected project root",
  );
const MAX_CATALOG_ARTIFACTS = 1_000;
const MAX_CONTENT_BYTES = 20_000;
const CATALOG_LINK_KINDS = [
  "references",
  "implements",
  "supersedes",
  "blocks",
  "related",
] as const;

const catalogLinkSchema = z
  .object({
    kind: z.enum(CATALOG_LINK_KINDS),
    target: z.string().min(1).max(500),
  })
  .strict();

const catalogArtifactSchema = z
  .object({
    file_path: z.string(),
    kind: z.enum([
      "readme",
      "architecture",
      "adr",
      "specification",
      "plan",
      "runbook",
      "security",
      "changelog",
      "contributing",
      "documentation",
    ]),
    title: z.string().optional(),
    size_bytes: z.number().int().nonnegative(),
    links: catalogLinkSchema.array().max(50),
    indexed_at: z.string(),
  })
  .strict();

const catalogStoreSchema = z
  .object({
    version: z.literal(LOCAL_STATE_VERSION),
    scope: catalogScopeSchema.default(DEFAULT_CATALOG_SCOPE),
    generated_at: z.string(),
    source_revision: z.string().regex(/^[a-f0-9]{64}$/u),
    truncated: z.boolean(),
    artifacts: catalogArtifactSchema.array().max(MAX_CATALOG_ARTIFACTS),
  })
  .strict();

export const refreshProjectCatalogSchema = z.object({
  directory: z.string().optional().default(".").describe("Project directory"),
  scope: catalogScopeSchema
    .optional()
    .default(DEFAULT_CATALOG_SCOPE)
    .describe("Local catalog namespace isolated inside this project"),
  max_files: z
    .number()
    .int()
    .positive()
    .max(MAX_CATALOG_ARTIFACTS)
    .optional()
    .default(MAX_CATALOG_ARTIFACTS)
    .describe("Maximum documentation files to inspect"),
});

export type RefreshProjectCatalogInput = z.input<
  typeof refreshProjectCatalogSchema
>;

export const getProjectCatalogSchema = z.object({
  directory: z.string().optional().default(".").describe("Project directory"),
  scope: catalogScopeSchema
    .optional()
    .default(DEFAULT_CATALOG_SCOPE)
    .describe("Local catalog namespace isolated inside this project"),
  query: z.string().trim().max(500).optional().default(""),
  search_mode: z
    .enum(["hybrid", "lexical"])
    .optional()
    .default("hybrid")
    .describe("Use weighted phrase/field matching or simple lexical matching"),
  kind: z
    .enum([
      "readme",
      "architecture",
      "adr",
      "specification",
      "plan",
      "runbook",
      "security",
      "changelog",
      "contributing",
      "documentation",
    ])
    .optional(),
  limit: z.number().int().positive().max(200).optional().default(50),
  cursor: z.string().max(1_024).optional(),
  include_content: z.boolean().optional().default(false),
  max_content_bytes: z
    .number()
    .int()
    .positive()
    .max(MAX_CONTENT_BYTES)
    .optional()
    .default(4_000),
  redact_secrets: z.boolean().optional().default(true),
});

export type GetProjectCatalogInput = z.input<typeof getProjectCatalogSchema>;

const catalogArtifactOutputSchema = catalogArtifactSchema.extend({
  content: z.string().optional(),
  content_truncated: z.boolean().optional(),
});

const refreshProjectCatalogDataSchema = z
  .object({
    directory: z.string(),
    scope: z.string(),
    catalog_file: z.string(),
    state: z.literal("ready"),
    source_revision: z.string().regex(/^[a-f0-9]{64}$/u),
    artifacts_count: z.number().int().nonnegative(),
    files_analyzed: z.number().int().nonnegative(),
    truncated: z.boolean(),
    source_is_untrusted: z.literal(true),
    secrets_redacted: z.literal(true),
    errors: z.string().array(),
  })
  .strict();

export const refreshProjectCatalogOutputSchema = createFeatureResultSchema(
  refreshProjectCatalogDataSchema,
);

const getProjectCatalogDataSchema = z
  .object({
    directory: z.string(),
    scope: z.string(),
    catalog_file: z.string(),
    state: z.enum(["missing", "ready"]),
    query: z.string(),
    search_mode: z.enum(["hybrid", "lexical"]),
    artifacts_total: z.number().int().nonnegative(),
    artifacts_returned: z.number().int().nonnegative(),
    cursor_offset: z.number().int().nonnegative(),
    next_cursor: z.string().optional(),
    truncated: z.boolean(),
    source_revision: z.string(),
    source_is_untrusted: z.literal(true),
    secrets_redacted: z.boolean(),
    artifacts: catalogArtifactOutputSchema.array(),
    errors: z.string().array(),
  })
  .strict();

export const getProjectCatalogOutputSchema = createFeatureResultSchema(
  getProjectCatalogDataSchema,
);

type CatalogLink = z.infer<typeof catalogLinkSchema>;
type CatalogArtifact = z.infer<typeof catalogArtifactSchema>;
type CatalogStore = z.infer<typeof catalogStoreSchema>;

function catalogFileName(scope: string): string {
  return scope === DEFAULT_CATALOG_SCOPE
    ? CATALOG_FILE
    : `artifacts-catalog-${scope}.json`;
}

function loadCatalog(
  root: string,
  scope: string,
):
  | { ok: true; exists: boolean; store: CatalogStore }
  | { ok: false; error: string } {
  const result = readLocalState(root, catalogFileName(scope));
  if (!result.ok) {
    return result;
  }
  if (!result.exists || result.value === undefined) {
    return {
      ok: true,
      exists: false,
      store: {
        version: LOCAL_STATE_VERSION,
        scope,
        generated_at: new Date(0).toISOString(),
        source_revision: crypto
          .createHash("sha256")
          .update("empty")
          .digest("hex"),
        truncated: false,
        artifacts: [],
      },
    };
  }
  const parsed = catalogStoreSchema.safeParse(result.value);
  if (parsed.success && parsed.data.scope !== scope) {
    return {
      ok: false,
      error: "Project artifact catalog scope does not match the request",
    };
  }
  if (!parsed.success) {
    return {
      ok: false,
      error: "Project artifact catalog is corrupt or unsupported",
    };
  }
  return { ok: true, exists: true, store: parsed.data };
}

function sourceRevision(artifacts: readonly CatalogArtifact[]): string {
  const canonical = artifacts
    .map((artifact) => JSON.stringify(artifact))
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function typedLink(value: string): CatalogLink {
  const match =
    /^(references|implements|supersedes|blocks|related):(.+)$/iu.exec(
      value.trim(),
    );
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return {
      kind: match[1].toLowerCase() as (typeof CATALOG_LINK_KINDS)[number],
      target: match[2].trim(),
    };
  }
  return { kind: "references", target: value.trim() };
}

function catalogFromArtifacts(
  artifacts: readonly ProjectArtifact[],
  generatedAt: string,
): CatalogArtifact[] {
  return artifacts.slice(0, MAX_CATALOG_ARTIFACTS).map((artifact) => ({
    file_path: artifact.file_path,
    kind: artifact.kind,
    ...(artifact.title === undefined ? {} : { title: artifact.title }),
    size_bytes: artifact.size_bytes,
    links: artifact.links
      .map(typedLink)
      .filter((link) => link.target.length > 0)
      .slice(0, 50),
    indexed_at: generatedAt,
  }));
}

export async function executeRefreshProjectCatalog(
  rawInput: RefreshProjectCatalogInput,
): Promise<FeatureResult> {
  const input = refreshProjectCatalogSchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }
  const root = secureDirectory.path;
  const catalogFile = catalogFileName(input.scope);
  return withLocalStateLock(root, catalogFile, async () => {
    const scan = await projectArtifactsFeature.execute({
      directory: root,
      query: "",
      limit: MAX_CATALOG_ARTIFACTS,
      max_files: input.max_files,
      include_content: false,
      max_content_bytes: 1,
      redact_secrets: true,
    });
    if (!scan.success || scan.data === undefined) {
      return {
        success: false,
        error: scan.error ?? "Unable to scan project artifacts",
      };
    }
    const data = scan.data as ProjectArtifactsOutput;
    const generatedAt = new Date().toISOString();
    const artifacts = catalogFromArtifacts(data.artifacts, generatedAt);
    const store: CatalogStore = {
      version: LOCAL_STATE_VERSION,
      scope: input.scope,
      generated_at: generatedAt,
      source_revision: sourceRevision(artifacts),
      truncated:
        data.truncated || data.artifacts.length >= MAX_CATALOG_ARTIFACTS,
      artifacts,
    };
    writeLocalState(root, catalogFile, store);
    const output = {
      directory: root,
      scope: input.scope,
      catalog_file: localStateRelativePath(catalogFile),
      state: "ready" as const,
      source_revision: store.source_revision,
      artifacts_count: artifacts.length,
      files_analyzed: data.files_analyzed,
      truncated: store.truncated,
      source_is_untrusted: true as const,
      secrets_redacted: true as const,
      errors: data.errors,
    };
    return {
      success: true,
      message: `Project artifact catalog refreshed: ${String(artifacts.length)} document${artifacts.length === 1 ? "" : "s"}${store.truncated ? " (truncated)" : ""}`,
      data: output,
    };
  });
}

export function executeGetProjectCatalog(
  rawInput: GetProjectCatalogInput,
): FeatureResult {
  const input = getProjectCatalogSchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }
  const root = secureDirectory.path;
  const catalogFile = catalogFileName(input.scope);
  const loaded = loadCatalog(root, input.scope);
  if (!loaded.ok) {
    return { success: false, error: loaded.error };
  }
  const terms = queryTerms(input.query);
  const scope = createPaginationScope({
    directory: root,
    catalog_scope: input.scope,
    query: input.query,
    search_mode: input.search_mode,
    kind: input.kind ?? null,
    source_revision: loaded.store.source_revision,
  });
  const cursor = decodePaginationCursor(input.cursor, scope);
  if (!cursor.ok) {
    return { success: false, error: cursor.error };
  }
  const candidates = loaded.store.artifacts
    .filter(
      (artifact) => input.kind === undefined || artifact.kind === input.kind,
    )
    .map((artifact) => ({
      artifact,
      score: artifactScore(artifact, terms, input.query, input.search_mode),
    }))
    .filter(({ score }) => terms.length === 0 || score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.artifact.file_path.localeCompare(right.artifact.file_path),
    );
  const page = candidates.slice(cursor.offset, cursor.offset + input.limit);
  const truncated =
    loaded.store.truncated || cursor.offset + page.length < candidates.length;
  const nextCursor =
    cursor.offset + page.length < candidates.length
      ? createPaginationCursor(scope, cursor.offset + page.length)
      : undefined;
  let secretsRedacted = false;
  const errors: string[] = [];
  const artifacts = page.map(({ artifact }) => {
    if (!input.include_content) {
      return artifact;
    }
    const file = path.join(root, artifact.file_path);
    const read = readSecureTextFile(file, root);
    if (!read.ok || read.content === undefined) {
      errors.push(`Cannot read ${artifact.file_path}`);
      return artifact;
    }
    const source = input.redact_secrets
      ? redactSourceText(read.content)
      : { text: read.content, redacted: false };
    secretsRedacted ||= source.redacted;
    const bounded = truncateUtf8WithStatus(
      source.text,
      input.max_content_bytes,
    );
    return {
      ...artifact,
      content: bounded.text,
      content_truncated: bounded.truncated,
    };
  });
  const data = {
    directory: root,
    scope: input.scope,
    catalog_file: localStateRelativePath(catalogFile),
    state: loaded.exists ? ("ready" as const) : ("missing" as const),
    query: input.query,
    artifacts_total: candidates.length,
    artifacts_returned: artifacts.length,
    cursor_offset: cursor.offset,
    ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
    truncated,
    source_revision: loaded.store.source_revision,
    source_is_untrusted: true as const,
    secrets_redacted: secretsRedacted,
    artifacts,
    errors,
  };
  return {
    success: true,
    message: `Project artifact catalog: ${String(artifacts.length)} document${artifacts.length === 1 ? "" : "s"}${truncated ? " (truncated)" : ""}`,
    data,
  };
}

export const refreshProjectCatalogFeature: Feature<
  typeof refreshProjectCatalogSchema
> = {
  name: "refresh_project_catalog",
  title: "Refresh project artifact catalog",
  description:
    "Scan local project documentation and persist a bounded metadata-only artifact catalog with typed references. It never stores document bodies, contacts remote services, or executes project content.",
  schema: refreshProjectCatalogSchema,
  outputSchema: refreshProjectCatalogOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execute: executeRefreshProjectCatalog,
};

export const getProjectCatalogFeature: Feature<typeof getProjectCatalogSchema> =
  {
    name: "get_project_catalog",
    title: "Get project artifact catalog",
    description:
      "Read the bounded, project-isolated local artifact catalog created by refresh_project_catalog, optionally including redacted live document excerpts.",
    schema: getProjectCatalogSchema,
    outputSchema: getProjectCatalogOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute: executeGetProjectCatalog,
  };
