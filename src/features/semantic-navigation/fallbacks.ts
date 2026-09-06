import * as path from "node:path";

import { lookupScip, readScipCatalog } from "@core/navigation/scip";
import { parseCode } from "@core/parser";
import { readSecureTextFile, resolveSecureFile } from "@core/security";
import { findSymbolsFeature } from "@features/find-symbols";
import { symbolAtPositionFeature } from "@features/symbol-at-position";
import type { FeatureResult } from "@features/types";

import {
  boundedText,
  identifierAtPosition,
  locationKey,
  positionFromLsp,
  stringIndexAtByteOffset,
} from "./common";
import type { SemanticNavigationOptions } from "./schema";
import type {
  FindSymbolsData,
  NavigationDiagnostic,
  NavigationLocation,
  SemanticNavigationOutput,
  SymbolAtPositionData,
} from "./types";

function fallbackPosition(
  data: SymbolAtPositionData,
): { name: string; type: string; signature?: string } | undefined {
  const symbol = data.symbol;
  if (!data.found || symbol?.name === undefined) {
    return undefined;
  }
  return {
    name: symbol.name,
    type: symbol.type ?? "symbol",
    ...(symbol.signature === undefined ? {} : { signature: symbol.signature }),
  };
}

export function executeScipFallback(
  input: SemanticNavigationOptions,
  root: string,
  language: string,
  content: string,
): FeatureResult | undefined {
  if (input.operation === "diagnostics") {
    return undefined;
  }
  const catalogResult = readScipCatalog(root);
  if (!catalogResult.ok) {
    return input.backend === "scip"
      ? { success: false, error: catalogResult.error }
      : undefined;
  }
  if (catalogResult.catalog === undefined) {
    return undefined;
  }
  const queryName = identifierAtPosition(content, input.line, input.column);
  const lookup = lookupScip(
    catalogResult.catalog,
    input.file_path,
    input.line - 1,
    input.column,
    queryName,
    input.operation,
  );
  const symbol =
    lookup.symbol === undefined
      ? queryName === undefined
        ? undefined
        : { name: queryName, type: "symbol" }
      : {
          name: queryName ?? lookup.symbol.symbol,
          type: lookup.symbol.kind ?? "symbol",
        };
  let secretsRedacted = false;
  if (input.operation === "hover") {
    const bounded = boundedText(
      lookup.hover ?? "",
      input.max_source_bytes,
      input.redact_secrets,
    );
    secretsRedacted ||= bounded.redacted;
    const output: SemanticNavigationOutput = {
      operation: input.operation,
      requested_backend: input.backend,
      backend_used: "scip",
      file_path: input.file_path,
      language,
      position: { line: input.line, column: input.column },
      source_revision: catalogResult.catalog.source_revision,
      ...(symbol === undefined ? {} : { symbol }),
      locations: [],
      hover: { contents: bounded.text },
      coverage: "precise",
      confidence: bounded.text.length > 0 ? 0.93 : 0.72,
      truncated: bounded.truncated,
      external_locations_ignored: 0,
      source_is_untrusted: true,
      secrets_redacted: secretsRedacted,
      warnings: [
        "SCIP is a local imported snapshot; re-import it after source changes.",
      ],
    };
    return {
      success: true,
      message: `SCIP hover for ${symbol?.name ?? "the requested position"}`,
      data: output,
    };
  }

  const locations: NavigationLocation[] = [];
  let ignoredExternal = 0;
  let truncated = lookup.locations.length > input.max_results;
  const seen = new Set<string>();
  for (const location of lookup.locations) {
    const secureFile = resolveSecureFile(
      path.resolve(root, location.file_path),
      root,
    );
    if (!secureFile.ok) {
      ignoredExternal += 1;
      continue;
    }
    const read = readSecureTextFile(secureFile.path, root);
    if (!read.ok || read.content === undefined) {
      continue;
    }
    const start = positionFromLsp(read.content, {
      line: location.range.start_line,
      character: location.range.start_column,
    });
    const end = positionFromLsp(read.content, {
      line: location.range.end_line,
      character: location.range.end_column,
    });
    if (start === undefined || end === undefined) {
      continue;
    }
    const result: NavigationLocation = {
      file_path: location.file_path,
      start,
      end,
    };
    if (input.include_source) {
      const startIndex = stringIndexAtByteOffset(read.content, start.offset);
      const endIndex = stringIndexAtByteOffset(read.content, end.offset);
      const bounded = boundedText(
        read.content.slice(startIndex, endIndex),
        input.max_source_bytes,
        input.redact_secrets,
      );
      result.snippet = bounded.text;
      truncated ||= bounded.truncated;
      secretsRedacted ||= bounded.redacted;
    }
    const key = locationKey(result);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    locations.push(result);
    if (locations.length >= input.max_results) {
      break;
    }
  }
  const output: SemanticNavigationOutput = {
    operation: input.operation,
    requested_backend: input.backend,
    backend_used: "scip",
    file_path: input.file_path,
    language,
    position: { line: input.line, column: input.column },
    source_revision: catalogResult.catalog.source_revision,
    ...(symbol === undefined ? {} : { symbol }),
    locations,
    coverage: "precise",
    confidence: locations.length > 0 ? 0.94 : 0.7,
    truncated,
    external_locations_ignored: ignoredExternal,
    source_is_untrusted: true,
    secrets_redacted: secretsRedacted,
    warnings: [
      "SCIP is a local imported snapshot; re-import it after source changes.",
    ],
  };
  return {
    success: true,
    message: `SCIP ${input.operation}: ${String(locations.length)} result${locations.length === 1 ? "" : "s"}`,
    data: output,
  };
}

export async function executeFallback(
  input: SemanticNavigationOptions,
  root: string,
  language: string,
  content: string,
): Promise<FeatureResult> {
  const symbolResult = await symbolAtPositionFeature.execute({
    directory: root,
    file_path: input.file_path,
    line: input.line,
    column: input.column,
    include_source: true,
    max_source_bytes: input.max_source_bytes,
    redact_secrets: input.redact_secrets,
  });
  if (!symbolResult.success) {
    return symbolResult;
  }
  const symbolData = symbolResult.data as SymbolAtPositionData | undefined;
  const containingSymbol =
    symbolData === undefined ? undefined : fallbackPosition(symbolData);
  const queryName =
    identifierAtPosition(content, input.line, input.column) ??
    containingSymbol?.name;
  const symbol =
    queryName === undefined
      ? containingSymbol
      : containingSymbol?.name === queryName
        ? containingSymbol
        : { name: queryName, type: "reference" };
  const warnings: string[] = [
    "Tree-sitter fallback is syntax/text based and does not prove compiler-level symbol identity.",
  ];
  let secretsRedacted = false;
  if (symbolData?.symbol?.source !== undefined) {
    secretsRedacted =
      input.redact_secrets && symbolData.symbol.source.includes("[REDACTED");
  }

  if (input.operation === "diagnostics") {
    const lines = content.split("\n");
    let diagnostics: NavigationDiagnostic[] = [];
    try {
      const parsed = await parseCode(content, {
        filePath: path.join(root, input.file_path),
      });
      if (parsed.tree.rootNode.hasError) {
        const lastLine = Math.max(1, lines.length);
        const lastColumn = Array.from(lines[lastLine - 1] ?? "").length;
        diagnostics = [
          {
            message:
              "Tree-sitter detected one or more syntax errors in this file",
            start: { line: 1, column: 0, offset: 0 },
            end: {
              line: lastLine,
              column: lastColumn,
              offset: Buffer.byteLength(content, "utf8"),
            },
            severity: "error",
            source: "treesitter",
          },
        ];
      }
    } catch {
      warnings.push("Tree-sitter could not parse the file for diagnostics.");
    }
    const output: SemanticNavigationOutput = {
      operation: input.operation,
      requested_backend: input.backend,
      backend_used: "treesitter",
      file_path: input.file_path,
      language,
      position: { line: input.line, column: input.column },
      ...(symbol === undefined ? {} : { symbol }),
      locations: [],
      diagnostics,
      coverage: "approximate",
      confidence: diagnostics.length > 0 ? 0.58 : 0.42,
      truncated: false,
      external_locations_ignored: 0,
      source_is_untrusted: true,
      secrets_redacted: secretsRedacted,
      warnings,
    };
    return {
      success: true,
      message: `Approximate syntax diagnostics: ${String(diagnostics.length)} finding${diagnostics.length === 1 ? "" : "s"}`,
      data: output,
    };
  }

  if (
    input.operation === "implementation" ||
    input.operation === "type_hierarchy"
  ) {
    warnings.push(
      `${input.operation === "implementation" ? "Implementation" : "Type hierarchy"} lookup requires a local LSP; no approximate result was fabricated.`,
    );
    const output: SemanticNavigationOutput = {
      operation: input.operation,
      requested_backend: input.backend,
      backend_used: "treesitter",
      file_path: input.file_path,
      language,
      position: { line: input.line, column: input.column },
      ...(symbol === undefined ? {} : { symbol }),
      locations: [],
      coverage: "unavailable",
      confidence: 0,
      truncated: false,
      external_locations_ignored: 0,
      source_is_untrusted: true,
      secrets_redacted: secretsRedacted,
      warnings,
    };
    return {
      success: true,
      message: "No local semantic implementation backend available",
      data: output,
    };
  }

  if (queryName === undefined) {
    warnings.push("No Tree-sitter symbol was found at the requested position.");
    const output: SemanticNavigationOutput = {
      operation: input.operation,
      requested_backend: input.backend,
      backend_used: "treesitter",
      file_path: input.file_path,
      language,
      position: { line: input.line, column: input.column },
      locations: [],
      coverage: "unavailable",
      confidence: 0,
      truncated: false,
      external_locations_ignored: 0,
      source_is_untrusted: true,
      secrets_redacted: secretsRedacted,
      warnings,
    };
    return {
      success: true,
      message: "No symbol found at the requested position",
      data: output,
    };
  }

  if (input.operation === "hover") {
    const raw = symbolData?.symbol;
    const hoverText = [raw?.documentation, raw?.signature, raw?.source]
      .filter(
        (value): value is string =>
          value !== undefined && value.trim().length > 0,
      )
      .join("\n\n");
    const bounded = boundedText(
      hoverText,
      input.max_source_bytes,
      input.redact_secrets,
    );
    secretsRedacted ||= bounded.redacted;
    const output: SemanticNavigationOutput = {
      operation: input.operation,
      requested_backend: input.backend,
      backend_used: "treesitter",
      file_path: input.file_path,
      language,
      position: { line: input.line, column: input.column },
      symbol,
      locations: [],
      hover: { contents: bounded.text },
      coverage: "approximate",
      confidence: bounded.text.length > 0 ? 0.58 : 0.25,
      truncated: bounded.truncated,
      external_locations_ignored: 0,
      source_is_untrusted: true,
      secrets_redacted: secretsRedacted,
      warnings,
    };
    return {
      success: true,
      message: `Approximate hover for ${queryName}`,
      data: output,
    };
  }

  const findResult = await findSymbolsFeature.execute({
    directory: root,
    query: queryName,
    mode: input.operation === "references" ? "references" : "definitions",
    limit: input.max_results,
    max_files: input.max_files,
    redact_secrets: input.redact_secrets,
  });
  if (!findResult.success) {
    return findResult;
  }
  const found = (findResult.data as FindSymbolsData | undefined) ?? {};
  const locations = (found.matches ?? [])
    .filter(
      (
        match,
      ): match is Required<Pick<typeof match, "file_path" | "start" | "end">> &
        typeof match =>
        match.file_path !== undefined &&
        match.start !== undefined &&
        match.end !== undefined,
    )
    .map((match) => ({
      file_path: match.file_path,
      start: match.start,
      end: match.end,
      ...(match.snippet === undefined ? {} : { snippet: match.snippet }),
    }));
  const output: SemanticNavigationOutput = {
    operation: input.operation,
    requested_backend: input.backend,
    backend_used: "treesitter",
    file_path: input.file_path,
    language,
    position: { line: input.line, column: input.column },
    symbol,
    locations,
    coverage: "approximate",
    confidence: locations.length > 0 ? 0.62 : 0.25,
    truncated: found.truncated ?? false,
    external_locations_ignored: 0,
    source_is_untrusted: true,
    secrets_redacted: secretsRedacted,
    warnings,
  };
  return {
    success: true,
    message: `Approximate ${input.operation} lookup for ${queryName}: ${String(locations.length)} result${locations.length === 1 ? "" : "s"}`,
    data: output,
  };
}
