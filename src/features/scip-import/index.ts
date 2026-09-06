import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import {
  hashScipPayload,
  parseScipPayload,
  SCIP_CATALOG_FILE,
  writeScipCatalog,
} from "@core/navigation/scip";
import { withLocalStateLock } from "@core/local-state";
import {
  readSecureTextFile,
  resolveSecureDirectory,
  resolveSecureFile,
  safeErrorMessage,
} from "@core/security";
import type { Feature, FeatureResult } from "@features/types";
import { createFeatureResultSchema } from "@features/utils";

const execFileAsync = promisify(execFile);
const MAX_TIMEOUT_MS = 60_000;
const MAX_INPUT_BYTES = 128 * 1024 * 1024;

export const scipImportSchema = z.object({
  directory: z.string().optional().default(".").describe("Project directory"),
  index_file: z
    .string()
    .trim()
    .min(1)
    .max(1_000)
    .optional()
    .default("index.scip")
    .describe("Existing project-relative SCIP file or JSON export"),
  format: z
    .enum(["auto", "json", "cli"])
    .optional()
    .default("auto")
    .describe("Read JSON directly or ask the local scip CLI to print JSON"),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .default(15_000),
});

export type ScipImportInput = z.input<typeof scipImportSchema>;

const scipImportDataSchema = z
  .object({
    directory: z.string(),
    index_file: z.string(),
    catalog_file: z.string(),
    source_format: z.enum(["json", "cli"]),
    source_revision: z.string().regex(/^[a-f0-9]{64}$/u),
    documents: z.number().int().nonnegative(),
    occurrences: z.number().int().nonnegative(),
    symbols: z.number().int().nonnegative(),
    truncated: z.boolean(),
    source_is_untrusted: z.literal(true),
    secrets_redacted: z.literal(true),
  })
  .strict();

export const scipImportOutputSchema =
  createFeatureResultSchema(scipImportDataSchema);

function isSafeRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/gu, "/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !/^[a-z]:\//iu.test(normalized) &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    !normalized.split("/").includes("..")
  );
}

async function readViaScipCli(
  filePath: string,
  root: string,
  timeoutMs: number,
): Promise<string> {
  try {
    const result = await execFileAsync("scip", ["print", "--json", filePath], {
      cwd: root,
      windowsHide: true,
      shell: false,
      timeout: timeoutMs,
      maxBuffer: MAX_INPUT_BYTES,
    });
    return result.stdout;
  } catch (error) {
    throw new Error(
      `Local SCIP CLI unavailable: ${safeErrorMessage(error, "scip executable or index could not be used")}`,
    );
  }
}

export async function execute(
  rawInput: ScipImportInput,
): Promise<FeatureResult> {
  const input = scipImportSchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }
  const root = secureDirectory.path;
  if (!isSafeRelativePath(input.index_file)) {
    return {
      success: false,
      error: "index_file must be a safe project-relative path",
    };
  }
  const resolvedFile = resolveSecureFile(
    path.resolve(root, input.index_file),
    root,
  );
  if (!resolvedFile.ok) {
    return { success: false, error: resolvedFile.error };
  }

  return withLocalStateLock(root, SCIP_CATALOG_FILE, async () => {
    let payloadText: string | undefined;
    let sourceFormat: "json" | "cli" = "json";
    if (input.format !== "cli") {
      const read = readSecureTextFile(resolvedFile.path, root);
      if (read.ok && read.content !== undefined) {
        try {
          const parsed: unknown = JSON.parse(read.content);
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            Array.isArray((parsed as { documents?: unknown }).documents)
          ) {
            payloadText = read.content;
          }
        } catch {
          // Auto mode can fall through to the local CLI for binary SCIP.
        }
      }
      if (input.format === "json" && payloadText === undefined) {
        return {
          success: false,
          error: "SCIP JSON export is invalid or unreadable",
        };
      }
    }
    if (payloadText === undefined) {
      try {
        payloadText = await readViaScipCli(
          resolvedFile.path,
          root,
          input.timeout_ms,
        );
        sourceFormat = "cli";
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Unable to read SCIP index",
        };
      }
    }
    if (Buffer.byteLength(payloadText, "utf8") > MAX_INPUT_BYTES) {
      return { success: false, error: "SCIP export exceeds the safety limit" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadText) as unknown;
    } catch {
      return { success: false, error: "SCIP CLI output is not valid JSON" };
    }
    const catalog = parseScipPayload(parsed, hashScipPayload(payloadText));
    writeScipCatalog(root, catalog);
    const output = {
      directory: root,
      index_file: input.index_file.replace(/\\/gu, "/").replace(/^\.\//u, ""),
      catalog_file: ".src-index/scip-catalog.json",
      source_format: sourceFormat,
      source_revision: catalog.source_revision,
      documents: catalog.documents.length,
      occurrences: catalog.occurrences_count,
      symbols: catalog.symbols_count,
      truncated: catalog.truncated,
      source_is_untrusted: true as const,
      secrets_redacted: true as const,
    };
    return {
      success: true,
      message: `Imported SCIP catalog: ${String(output.documents)} document${output.documents === 1 ? "" : "s"}, ${String(output.symbols)} symbol${output.symbols === 1 ? "" : "s"}`,
      data: output,
    };
  });
}

export const scipImportFeature: Feature<typeof scipImportSchema> = {
  name: "import_scip_index",
  title: "Import local SCIP index",
  description:
    "Import a local SCIP JSON export, or ask an installed local scip CLI to print a binary SCIP index as JSON, into the project-isolated catalog used by semantic navigation. No remote service or project script is executed.",
  schema: scipImportSchema,
  outputSchema: scipImportOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execute,
};
