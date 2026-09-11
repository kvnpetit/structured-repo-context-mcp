import * as path from "node:path";

import { detectNavigationLanguage, requestLsp } from "@core/navigation/lsp";
import {
  mergeInstructionSignals,
  readSecureTextFile,
  resolveSecureDirectory,
  resolveSecureFile,
  safeErrorMessage,
  scanInstructionSignals,
} from "@core/security";
import type { Feature, FeatureResult } from "@features/types";
import { boundedText, positionFromLsp, renderHoverValue } from "./common";
import { executeFallback, executeScipFallback } from "./fallbacks";
import { mapLspDiagnostics, mapLspLocations } from "./lsp-mappers";
import {
  semanticNavigationOutputSchema,
  semanticNavigationSchema,
  type SemanticNavigationInput,
} from "./schema";
import type { SemanticNavigationOutput } from "./types";

export {
  semanticNavigationOutputSchema,
  semanticNavigationSchema,
  type SemanticNavigationInput,
} from "./schema";

async function executeNavigation(
  rawInput: SemanticNavigationInput,
  context?: { signal?: AbortSignal },
): Promise<FeatureResult> {
  const input = semanticNavigationSchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }
  const root = secureDirectory.path;
  const secureFile = resolveSecureFile(path.resolve(root, input.file_path), root);
  if (!secureFile.ok) {
    return { success: false, error: secureFile.error };
  }
  const readResult = readSecureTextFile(secureFile.path, root);
  if (!readResult.ok || readResult.content === undefined) {
    return {
      success: false,
      error: readResult.ok ? "File cannot be read" : readResult.error,
    };
  }
  const language = detectNavigationLanguage(secureFile.path);
  const safeFilePath = path.relative(root, secureFile.path).replace(/\\/gu, "/");
  const scopedInput = { ...input, directory: root, file_path: safeFilePath };

  if (scopedInput.backend === "scip") {
    const scipFallback = executeScipFallback(scopedInput, root, language, readResult.content);
    if (scipFallback !== undefined) {
      return scipFallback;
    }
    return {
      success: false,
      error: "No imported local SCIP catalog is available; run import_scip_index first",
    };
  }

  if (scopedInput.backend !== "treesitter") {
    const lspResult = await requestLsp({
      root,
      filePath: secureFile.path,
      content: readResult.content,
      language,
      line: input.line,
      column: input.column,
      operation: input.operation,
      timeoutMs: input.timeout_ms,
      signal: context?.signal,
    });
    if (lspResult.ok) {
      if (lspResult.result.kind === "hover") {
        const rawHover = renderHoverValue(lspResult.result.hover?.contents);
        const bounded = boundedText(rawHover, input.max_source_bytes, input.redact_secrets);
        const rawRange = lspResult.result.hover?.range;
        const hoverStart =
          rawRange === undefined ? undefined : positionFromLsp(readResult.content, rawRange.start);
        const hoverEnd =
          rawRange === undefined ? undefined : positionFromLsp(readResult.content, rawRange.end);
        const output: SemanticNavigationOutput = {
          operation: input.operation,
          requested_backend: scopedInput.backend,
          backend_used: "lsp",
          lsp_server: {
            id: lspResult.result.server.id,
            command: lspResult.result.server.command,
          },
          file_path: safeFilePath,
          language,
          position: { line: input.line, column: input.column },
          locations: [],
          hover: {
            contents: bounded.text,
            ...(hoverStart === undefined || hoverEnd === undefined
              ? {}
              : { range: { start: hoverStart, end: hoverEnd } }),
          },
          coverage: "precise",
          confidence: bounded.text.length > 0 ? 0.98 : 0.8,
          truncated: bounded.truncated,
          external_locations_ignored: 0,
          source_is_untrusted: true,
          secrets_redacted: bounded.redacted,
          warnings: [],
        };
        return {
          success: true,
          message: `Precise hover from ${lspResult.result.server.id}`,
          data: output,
        };
      }
      if (lspResult.result.kind === "diagnostics") {
        const mapped = mapLspDiagnostics(
          lspResult.result.diagnostics,
          readResult.content,
          input.max_results,
          input.redact_secrets,
        );
        const output: SemanticNavigationOutput = {
          operation: input.operation,
          requested_backend: scopedInput.backend,
          backend_used: "lsp",
          lsp_server: {
            id: lspResult.result.server.id,
            command: lspResult.result.server.command,
          },
          file_path: safeFilePath,
          language,
          position: { line: input.line, column: input.column },
          locations: [],
          diagnostics: mapped.diagnostics,
          coverage: "precise",
          confidence: mapped.diagnostics.length > 0 ? 0.97 : 0.88,
          truncated: mapped.truncated,
          external_locations_ignored: 0,
          source_is_untrusted: true,
          secrets_redacted: mapped.secretsRedacted,
          warnings: [],
        };
        return {
          success: true,
          message: `Precise diagnostics from ${lspResult.result.server.id}: ${String(mapped.diagnostics.length)} finding${mapped.diagnostics.length === 1 ? "" : "s"}`,
          data: output,
        };
      }
      const mapped = mapLspLocations(
        lspResult.result.locations,
        root,
        input.max_results,
        input.include_source,
        input.max_source_bytes,
        input.redact_secrets,
      );
      const output: SemanticNavigationOutput = {
        operation: input.operation,
        requested_backend: scopedInput.backend,
        backend_used: "lsp",
        lsp_server: {
          id: lspResult.result.server.id,
          command: lspResult.result.server.command,
        },
        file_path: safeFilePath,
        language,
        position: { line: input.line, column: input.column },
        locations: mapped.locations,
        coverage: "precise",
        confidence: mapped.locations.length > 0 ? 0.98 : 0.82,
        truncated: mapped.truncated,
        external_locations_ignored: mapped.ignoredExternal,
        source_is_untrusted: true,
        secrets_redacted: mapped.secretsRedacted,
        warnings:
          mapped.ignoredExternal > 0
            ? ["Locations outside the configured local project root were ignored."]
            : [],
      };
      return {
        success: true,
        message: `Precise ${input.operation} lookup from ${lspResult.result.server.id}: ${String(mapped.locations.length)} result${mapped.locations.length === 1 ? "" : "s"}`,
        data: output,
      };
    }
    if (scopedInput.backend === "lsp") {
      return {
        success: false,
        error: `Local LSP navigation failed: ${safeErrorMessage(lspResult.detail, "local language server unavailable")}`,
      };
    }
    const scipFallback = executeScipFallback(scopedInput, root, language, readResult.content);
    if (scipFallback !== undefined) {
      if (scipFallback.success && scipFallback.data !== undefined) {
        const data = scipFallback.data as SemanticNavigationOutput;
        data.warnings.unshift(
          `Precise local LSP unavailable (${lspResult.reason}); imported SCIP fallback used.`,
        );
      }
      return scipFallback;
    }
    const fallback = await executeFallback(scopedInput, root, language, readResult.content);
    if (fallback.success && fallback.data !== undefined) {
      const data = fallback.data as SemanticNavigationOutput;
      data.warnings.unshift(
        `Precise local LSP unavailable (${lspResult.reason}); Tree-sitter fallback used.`,
      );
    }
    return fallback;
  }
  return executeFallback(scopedInput, root, language, readResult.content);
}

function addInstructionSignals(result: FeatureResult): FeatureResult {
  if (!result.success || typeof result.data !== "object" || result.data === null) {
    return result;
  }
  const data = result.data as Record<string, unknown>;
  const scans: ReturnType<typeof scanInstructionSignals>[] = [];
  const sourceFile = typeof data.file_path === "string" ? data.file_path : "source";
  const hover = data.hover;
  if (typeof hover === "object" && hover !== null) {
    const contents = (hover as { contents?: unknown }).contents;
    if (typeof contents === "string") {
      scans.push(scanInstructionSignals(contents, { source: sourceFile }));
    }
  }
  if (Array.isArray(data.locations)) {
    for (const location of data.locations) {
      if (typeof location !== "object" || location === null) {
        continue;
      }
      const snippet = (location as { snippet?: unknown }).snippet;
      if (typeof snippet === "string") {
        scans.push(
          scanInstructionSignals(snippet, {
            source:
              typeof (location as { file_path?: unknown }).file_path === "string"
                ? (location as { file_path: string }).file_path
                : sourceFile,
          }),
        );
      }
    }
  }
  if (Array.isArray(data.diagnostics)) {
    for (const diagnostic of data.diagnostics) {
      if (typeof diagnostic !== "object" || diagnostic === null) {
        continue;
      }
      const message = (diagnostic as { message?: unknown }).message;
      if (typeof message === "string") {
        scans.push(scanInstructionSignals(message, { source: "diagnostic" }));
      }
    }
  }
  return {
    ...result,
    data: {
      ...data,
      instruction_signals: mergeInstructionSignals(scans),
    },
  };
}

export async function execute(
  rawInput: SemanticNavigationInput,
  context?: { signal?: AbortSignal },
): Promise<FeatureResult> {
  return addInstructionSignals(await executeNavigation(rawInput, context));
}

export const semanticNavigationFeature: Feature<typeof semanticNavigationSchema> = {
  name: "semantic_navigation",
  title: "Semantic navigation",
  description:
    "Navigate local code with an imported SCIP catalog or allow-listed local language server when available, using definitions, references, implementations, hover, type hierarchies, and diagnostics; otherwise fall back explicitly to bounded Tree-sitter analysis with confidence and coverage metadata.",
  schema: semanticNavigationSchema,
  outputSchema: semanticNavigationOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execute,
};
