import * as crypto from "node:crypto";

import { z } from "zod";

import { LOCAL_STATE_VERSION, readLocalState, writeLocalState } from "@core/local-state";

const MAX_DOCUMENTS = 5_000;
const MAX_OCCURRENCES = 200_000;
const MAX_SYMBOLS = 100_000;
const SCIP_DEFINITION_ROLE = 1;

const scipRangeSchema = z
  .object({
    start_line: z.number().int().nonnegative(),
    start_column: z.number().int().nonnegative(),
    end_line: z.number().int().nonnegative(),
    end_column: z.number().int().nonnegative(),
  })
  .strict();

const scipOccurrenceSchema = z
  .object({
    range: scipRangeSchema,
    symbol: z.string().min(1).max(1_000),
    roles: z.number().int().nonnegative(),
  })
  .strict();

const scipRelationshipSchema = z
  .object({
    symbol: z.string().min(1).max(1_000),
    is_implementation: z.boolean().optional(),
    is_type_definition: z.boolean().optional(),
  })
  .strict();

const scipSymbolSchema = z
  .object({
    symbol: z.string().min(1).max(1_000),
    documentation: z.string().max(20_000).optional(),
    kind: z.string().max(100).optional(),
    relationships: scipRelationshipSchema.array().max(100).optional(),
  })
  .strict();

const scipDocumentSchema = z
  .object({
    relative_path: z.string().min(1).max(1_000),
    language: z.string().max(100).optional(),
    occurrences: scipOccurrenceSchema.array().max(MAX_OCCURRENCES),
    symbols: scipSymbolSchema.array().max(MAX_SYMBOLS),
  })
  .strict();

const scipCatalogSchema = z
  .object({
    version: z.literal(LOCAL_STATE_VERSION),
    imported_at: z.string(),
    source_revision: z.string().regex(/^[a-f0-9]{64}$/u),
    documents: scipDocumentSchema.array().max(MAX_DOCUMENTS),
    occurrences_count: z.number().int().nonnegative(),
    symbols_count: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export type ScipRange = z.infer<typeof scipRangeSchema>;
export type ScipOccurrence = z.infer<typeof scipOccurrenceSchema>;
export type ScipRelationship = z.infer<typeof scipRelationshipSchema>;
export type ScipSymbol = z.infer<typeof scipSymbolSchema>;
export type ScipDocument = z.infer<typeof scipDocumentSchema>;
export type ScipCatalog = z.infer<typeof scipCatalogSchema>;

export const SCIP_CATALOG_FILE = "scip-catalog.json";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizedPath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function parseRange(value: unknown): ScipRange | undefined {
  if (Array.isArray(value)) {
    const values = value.map(numberValue);
    if (
      values.length === 3 &&
      values[0] !== undefined &&
      values[1] !== undefined &&
      values[2] !== undefined
    ) {
      return {
        start_line: values[0],
        start_column: values[1],
        end_line: values[0],
        end_column: values[2],
      };
    }
    if (
      values.length >= 4 &&
      values[0] !== undefined &&
      values[1] !== undefined &&
      values[2] !== undefined &&
      values[3] !== undefined
    ) {
      return {
        start_line: values[0],
        start_column: values[1],
        end_line: values[2],
        end_column: values[3],
      };
    }
  }
  const object = record(value);
  if (object === undefined) {
    return undefined;
  }
  const start = record(object.start);
  const end = record(object.end);
  const startLine = numberValue(object.start_line ?? start?.line);
  const startColumn = numberValue(object.start_column ?? start?.column);
  const endLine = numberValue(object.end_line ?? end?.line);
  const endColumn = numberValue(object.end_column ?? end?.column);
  if (
    startLine === undefined ||
    startColumn === undefined ||
    endLine === undefined ||
    endColumn === undefined
  ) {
    return undefined;
  }
  return {
    start_line: startLine,
    start_column: startColumn,
    end_line: endLine,
    end_column: endColumn,
  };
}

function parseDocumentation(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.slice(0, 20_000);
  }
  if (Array.isArray(value)) {
    const lines = value.filter((item): item is string => typeof item === "string");
    return lines.join("\n").slice(0, 20_000) || undefined;
  }
  return undefined;
}

function parseRelationship(value: unknown): ScipRelationship | undefined {
  const object = record(value);
  if (object === undefined) {
    return undefined;
  }
  const symbol = stringValue(object.symbol);
  if (symbol === undefined) {
    return undefined;
  }
  return {
    symbol,
    ...(booleanValue(object.is_implementation ?? object.isImplementation) === undefined
      ? {}
      : {
          is_implementation: booleanValue(object.is_implementation ?? object.isImplementation),
        }),
    ...(booleanValue(object.is_type_definition ?? object.isTypeDefinition) === undefined
      ? {}
      : {
          is_type_definition: booleanValue(object.is_type_definition ?? object.isTypeDefinition),
        }),
  };
}

function parseSymbol(value: unknown): ScipSymbol | undefined {
  const object = record(value);
  if (object === undefined) {
    return undefined;
  }
  const symbol = stringValue(object.symbol);
  if (symbol === undefined) {
    return undefined;
  }
  const relationships = Array.isArray(object.relationships)
    ? object.relationships
        .map(parseRelationship)
        .filter((item): item is ScipRelationship => item !== undefined)
        .slice(0, 100)
    : [];
  const kind = stringValue(object.kind ?? object.symbol_kind);
  return {
    symbol,
    ...(parseDocumentation(object.documentation) === undefined
      ? {}
      : { documentation: parseDocumentation(object.documentation) }),
    ...(kind === undefined ? {} : { kind }),
    ...(relationships.length === 0 ? {} : { relationships }),
  };
}

function parseOccurrence(value: unknown): ScipOccurrence | undefined {
  const object = record(value);
  if (object === undefined) {
    return undefined;
  }
  const symbol = stringValue(object.symbol);
  const range = parseRange(object.range);
  if (symbol === undefined || range === undefined) {
    return undefined;
  }
  const roles = numberValue(object.symbol_roles ?? object.symbolRoles) ?? 0;
  return { range, symbol, roles };
}

function parseDocument(value: unknown): ScipDocument | undefined {
  const object = record(value);
  if (object === undefined) {
    return undefined;
  }
  const relativePathValue = stringValue(object.relative_path ?? object.relativePath);
  if (relativePathValue === undefined) {
    return undefined;
  }
  const occurrences = Array.isArray(object.occurrences)
    ? object.occurrences
        .map(parseOccurrence)
        .filter((item): item is ScipOccurrence => item !== undefined)
        .slice(0, MAX_OCCURRENCES)
    : [];
  const symbols = Array.isArray(object.symbols)
    ? object.symbols
        .map(parseSymbol)
        .filter((item): item is ScipSymbol => item !== undefined)
        .slice(0, MAX_SYMBOLS)
    : [];
  const language = stringValue(object.language);
  return {
    relative_path: normalizedPath(relativePathValue),
    ...(language === undefined ? {} : { language }),
    occurrences,
    symbols,
  };
}

/** Convert a SCIP JSON export into a bounded local catalog. */
export function parseScipPayload(payload: unknown, sourceRevision: string): ScipCatalog {
  const object = record(payload);
  const documentsValue = object?.documents;
  const documents = Array.isArray(documentsValue)
    ? documentsValue
        .map(parseDocument)
        .filter((item): item is ScipDocument => item !== undefined)
        .slice(0, MAX_DOCUMENTS)
    : [];
  let occurrencesCount = 0;
  let symbolsCount = 0;
  let truncated = !Array.isArray(documentsValue) || documents.length < documentsValue.length;
  let occurrenceBudget = MAX_OCCURRENCES;
  let symbolBudget = MAX_SYMBOLS;
  const boundedDocuments = documents.map((document) => {
    const occurrences = document.occurrences.slice(0, occurrenceBudget);
    const symbols = document.symbols.slice(0, symbolBudget);
    occurrenceBudget -= occurrences.length;
    symbolBudget -= symbols.length;
    occurrencesCount += occurrences.length;
    symbolsCount += symbols.length;
    if (
      occurrences.length < document.occurrences.length ||
      symbols.length < document.symbols.length
    ) {
      truncated = true;
    }
    return { ...document, occurrences, symbols };
  });
  return {
    version: LOCAL_STATE_VERSION,
    imported_at: new Date().toISOString(),
    source_revision: sourceRevision,
    documents: boundedDocuments,
    occurrences_count: occurrencesCount,
    symbols_count: symbolsCount,
    truncated,
  };
}

export function readScipCatalog(
  root: string,
): { ok: true; catalog?: ScipCatalog } | { ok: false; error: string } {
  const result = readLocalState(root, SCIP_CATALOG_FILE);
  if (!result.ok) {
    return result;
  }
  if (!result.exists || result.value === undefined) {
    return { ok: true };
  }
  const parsed = scipCatalogSchema.safeParse(result.value);
  return parsed.success
    ? { ok: true, catalog: parsed.data }
    : {
        ok: false,
        error: "SCIP catalog is corrupt or has an unsupported version",
      };
}

export function writeScipCatalog(root: string, catalog: ScipCatalog): void {
  writeLocalState(root, SCIP_CATALOG_FILE, catalog);
}

export function hashScipPayload(payload: string | Buffer): string {
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export interface ScipLookupLocation {
  file_path: string;
  range: ScipRange;
}

export interface ScipLookupResult {
  symbol?: ScipSymbol;
  locations: ScipLookupLocation[];
  hover?: string;
}

function shortSymbolName(symbol: string): string {
  const parts = symbol.split(/[#/.:]/u).filter(Boolean);
  return parts.at(-1) ?? symbol;
}

function rangeContains(range: ScipRange, line: number, column: number): boolean {
  if (line < range.start_line || line > range.end_line) {
    return false;
  }
  if (line === range.start_line && column < range.start_column) {
    return false;
  }
  if (line === range.end_line && column > range.end_column) {
    return false;
  }
  return true;
}

/** Look up SCIP occurrences by an editor position or short symbol name. */
export function lookupScip(
  catalog: ScipCatalog,
  filePath: string,
  line: number,
  column: number,
  query: string | undefined,
  operation: "definition" | "references" | "implementation" | "type_hierarchy" | "hover",
): ScipLookupResult {
  const normalizedFile = normalizedPath(filePath);
  const document = catalog.documents.find(
    (item) => normalizedPath(item.relative_path) === normalizedFile,
  );
  const occurrence = document?.occurrences.find((item) => rangeContains(item.range, line, column));
  const symbolName = occurrence?.symbol ?? query;
  if (symbolName === undefined) {
    return { locations: [] };
  }
  const symbolInfo = catalog.documents
    .flatMap((item) => item.symbols)
    .find(
      (item) =>
        item.symbol === symbolName || shortSymbolName(item.symbol) === shortSymbolName(symbolName),
    );
  if (operation === "hover") {
    return {
      ...(symbolInfo === undefined ? {} : { symbol: symbolInfo }),
      locations: [],
      ...(symbolInfo?.documentation === undefined ? {} : { hover: symbolInfo.documentation }),
    };
  }
  const relatedSymbols = new Set<string>([symbolName]);
  if (operation === "implementation" || operation === "type_hierarchy") {
    for (const symbol of catalog.documents.flatMap((item) => item.symbols)) {
      for (const relationship of symbol.relationships ?? []) {
        if (
          relationship.symbol === symbolName &&
          (relationship.is_implementation === true || relationship.is_type_definition === true)
        ) {
          relatedSymbols.add(symbol.symbol);
        }
        if (
          symbol.symbol === symbolName &&
          (relationship.is_implementation === true || relationship.is_type_definition === true)
        ) {
          relatedSymbols.add(relationship.symbol);
        }
      }
    }
  }
  const locations = catalog.documents.flatMap((item) =>
    item.occurrences
      .filter((itemOccurrence) => relatedSymbols.has(itemOccurrence.symbol))
      .filter((itemOccurrence) =>
        operation === "definition" ? (itemOccurrence.roles & SCIP_DEFINITION_ROLE) !== 0 : true,
      )
      .map((itemOccurrence) => ({
        file_path: normalizedPath(item.relative_path),
        range: itemOccurrence.range,
      })),
  );
  return {
    ...(symbolInfo === undefined ? {} : { symbol: symbolInfo }),
    locations,
  };
}
