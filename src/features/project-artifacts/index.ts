import { z } from "zod";
import * as path from "node:path";

import { collectFiles, createIgnoreFilter } from "@core/files";
import {
  redactSourceText,
  readSecureTextFile,
  resolveSecureDirectory,
  mergeInstructionSignals,
  scanInstructionSignals,
} from "@core/security";
import { truncateUtf8WithStatus } from "@core/utils/utf8";
import type { Feature, FeatureResult } from "@features/types";
import {
  createFeatureResultSchema,
  instructionSignalsSchema,
} from "@features/utils";

const DEFAULT_MAX_FILES = 1_000;
const DEFAULT_MAX_CONTENT_BYTES = 4_000;
const artifactExtensions = new Set([".md", ".markdown", ".txt", ".rst"]);
const ADR_PATTERN = /(?:^|[-_])adr(?:[-_]|$)|(?:^|\/)adr(?:\/|$)/u;
const SPECIFICATION_PATTERN = /(?:spec|rfc|requirements?)/u;
const PLAN_PATTERN = /(?:plan|roadmap|proposal)/u;
const RUNBOOK_PATTERN = /(?:runbook|playbook|operations?|incident)/u;
const SECURITY_PATTERN = /(?:security|threat|vulnerability)/u;
const CHANGELOG_PATTERN = /(?:change|history|release|version)/u;
const CONTRIBUTING_PATTERN = /(?:contribut|development|getting-started)/u;
const HEADING_PATTERN = /^\s*#\s+(.+?)\s*#?\s*$/mu;

export const projectArtifactsSchema = z.object({
  directory: z.string().optional().default(".").describe("Project directory"),
  query: z
    .string()
    .trim()
    .optional()
    .default("")
    .describe(
      "Optional words to search in artifact paths, titles, and content",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(1_000)
    .optional()
    .default(50)
    .describe("Maximum artifacts returned"),
  max_files: z
    .number()
    .int()
    .positive()
    .max(DEFAULT_MAX_FILES)
    .optional()
    .default(DEFAULT_MAX_FILES)
    .describe("Maximum documentation files to inspect"),
  include_content: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include bounded redacted document content"),
  max_content_bytes: z
    .number()
    .int()
    .positive()
    .max(20_000)
    .optional()
    .default(DEFAULT_MAX_CONTENT_BYTES)
    .describe("Maximum content bytes per returned artifact"),
  redact_secrets: z
    .boolean()
    .optional()
    .default(true)
    .describe("Redact common inline secrets in returned content"),
});

export type ProjectArtifactsInput = z.input<typeof projectArtifactsSchema>;

export type ArtifactKind =
  | "readme"
  | "architecture"
  | "adr"
  | "specification"
  | "plan"
  | "runbook"
  | "security"
  | "changelog"
  | "contributing"
  | "documentation";

export interface ProjectArtifact {
  file_path: string;
  kind: ArtifactKind;
  title?: string;
  size_bytes: number;
  links: string[];
  relevance: number;
  content?: string;
  content_truncated?: boolean;
}

export interface ProjectArtifactsOutput {
  directory: string;
  query: string;
  files_analyzed: number;
  artifacts_found: number;
  truncated: boolean;
  source_is_untrusted: true;
  secrets_redacted: boolean;
  instruction_signals: ReturnType<typeof scanInstructionSignals>;
  artifacts: ProjectArtifact[];
  errors: string[];
}

const projectArtifactDataSchema = z
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
    links: z.string().array(),
    relevance: z.number().nonnegative(),
    content: z.string().optional(),
    content_truncated: z.boolean().optional(),
  })
  .strict();

const projectArtifactsDataSchema = z
  .object({
    directory: z.string(),
    query: z.string(),
    files_analyzed: z.number().int().nonnegative(),
    artifacts_found: z.number().int().nonnegative(),
    truncated: z.boolean(),
    source_is_untrusted: z.literal(true),
    secrets_redacted: z.boolean(),
    instruction_signals: instructionSignalsSchema,
    artifacts: projectArtifactDataSchema.array(),
    errors: z.string().array(),
  })
  .strict();

export const projectArtifactsOutputSchema = createFeatureResultSchema(
  projectArtifactsDataSchema,
);

function relativePath(root: string, filePath: string): string {
  return path.relative(root, filePath).replace(/\\/gu, "/");
}

function normalize(value: string): string {
  return value.replace(/\\/gu, "/").toLowerCase();
}

function isArtifactFile(filePath: string): boolean {
  return artifactExtensions.has(path.extname(filePath).toLowerCase());
}

function classifyArtifact(filePath: string): ArtifactKind {
  const normalized = normalize(filePath);
  const name = path.basename(normalized, path.extname(normalized));
  if (name === "readme") {
    return "readme";
  }
  if (name.includes("architecture") || name === "design") {
    return "architecture";
  }
  if (ADR_PATTERN.exec(normalized) !== null) {
    return "adr";
  }
  if (SPECIFICATION_PATTERN.exec(name) !== null) {
    return "specification";
  }
  if (PLAN_PATTERN.exec(name) !== null) {
    return "plan";
  }
  if (RUNBOOK_PATTERN.exec(name) !== null) {
    return "runbook";
  }
  if (SECURITY_PATTERN.exec(name) !== null) {
    return "security";
  }
  if (CHANGELOG_PATTERN.exec(name) !== null) {
    return "changelog";
  }
  if (CONTRIBUTING_PATTERN.exec(name) !== null) {
    return "contributing";
  }
  return "documentation";
}

function extractTitle(content: string, filePath: string): string | undefined {
  const heading = HEADING_PATTERN.exec(content)?.[1]?.trim();
  if (heading !== undefined && heading.length > 0) {
    return heading;
  }
  return path.basename(filePath, path.extname(filePath));
}

function extractLinks(content: string): string[] {
  const links = new Set<string>();
  for (const match of content.matchAll(
    /\[[^\]]+\]\(([^)\s]+)(?:\s+[^)]*)?\)/gu,
  )) {
    const link = match[1]?.trim();
    if (link) {
      links.add(link);
    }
  }
  return [...links].slice(0, 50);
}

function queryTerms(query: string): string[] {
  const terms = Array.from(
    query.toLowerCase().matchAll(/[a-z0-9_$-]+/gu),
    (match) => match[0],
  );
  return terms
    .filter((term, index, all) => all.indexOf(term) === index)
    .slice(0, 20);
}

function relevance(
  relativeFile: string,
  title: string | undefined,
  content: string,
  terms: readonly string[],
): number {
  if (terms.length === 0) {
    return 0;
  }
  const file = relativeFile.toLowerCase();
  const heading = title?.toLowerCase() ?? "";
  const body = content.toLowerCase();
  return terms.reduce(
    (score, term) =>
      score +
      (file.includes(term) ? 4 : 0) +
      (heading.includes(term) ? 5 : 0) +
      (body.includes(term) ? 1 : 0),
    0,
  );
}

export function execute(rawInput: ProjectArtifactsInput): FeatureResult {
  const input = projectArtifactsSchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }

  const root = secureDirectory.path;
  const files = collectFiles(root, createIgnoreFilter(root), root)
    .filter(isArtifactFile)
    .sort((left, right) => left.localeCompare(right));
  const boundedFiles = files.slice(0, input.max_files);
  const terms = queryTerms(input.query);
  const artifacts: ProjectArtifact[] = [];
  const errors: string[] = [];
  const instructionScans: ReturnType<typeof scanInstructionSignals>[] = [];
  let secretsRedacted = false;

  for (const file of boundedFiles) {
    const readResult = readSecureTextFile(file, root);
    if (!readResult.ok || readResult.content === undefined) {
      errors.push(`Cannot read ${relativePath(root, file)}`);
      continue;
    }
    const relativeFile = relativePath(root, file);
    instructionScans.push(
      scanInstructionSignals(readResult.content, { source: relativeFile }),
    );
    const title = extractTitle(readResult.content, relativeFile);
    const score = relevance(relativeFile, title, readResult.content, terms);
    if (terms.length > 0 && score === 0) {
      continue;
    }

    const artifact: ProjectArtifact = {
      file_path: relativeFile,
      kind: classifyArtifact(relativeFile),
      ...(title === undefined ? {} : { title }),
      size_bytes: Buffer.byteLength(readResult.content, "utf8"),
      links: extractLinks(readResult.content),
      relevance: score,
    };
    if (input.include_content) {
      const source = input.redact_secrets
        ? redactSourceText(readResult.content)
        : { text: readResult.content, redacted: false };
      secretsRedacted ||= source.redacted;
      const bounded = truncateUtf8WithStatus(
        source.text,
        input.max_content_bytes,
      );
      artifact.content = bounded.text;
      artifact.content_truncated = bounded.truncated;
    }
    artifacts.push(artifact);
  }

  artifacts.sort(
    (left, right) =>
      right.relevance - left.relevance ||
      left.file_path.localeCompare(right.file_path),
  );
  const truncated =
    files.length > boundedFiles.length || artifacts.length > input.limit;
  const output: ProjectArtifactsOutput = {
    directory: root,
    query: input.query,
    files_analyzed: boundedFiles.length,
    artifacts_found: artifacts.length,
    truncated,
    source_is_untrusted: true,
    secrets_redacted: secretsRedacted,
    instruction_signals: mergeInstructionSignals(instructionScans),
    artifacts: artifacts.slice(0, input.limit),
    errors,
  };

  return {
    success: true,
    message: `Project artifacts: ${String(output.artifacts.length)} document${output.artifacts.length === 1 ? "" : "s"}${truncated ? " (truncated)" : ""}`,
    data: output,
  };
}

export const projectArtifactsFeature: Feature<typeof projectArtifactsSchema> = {
  name: "get_project_artifacts",
  title: "Get project artifacts",
  description:
    "Discover and search bounded project documentation such as README files, architecture notes, ADRs, specifications, plans, runbooks, security notes, and changelogs without executing or persisting their content.",
  schema: projectArtifactsSchema,
  outputSchema: projectArtifactsOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execute,
};
