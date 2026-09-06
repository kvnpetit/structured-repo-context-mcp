import { z } from "zod";

import { getASTRoot } from "@core/parser";
import { extractCodeInfo } from "@core/symbols";
import {
  canParse,
  extractSymbols,
  getParsingCapabilities,
  parseFile,
} from "@core/unified";
import { redactStructuredValue } from "@core/security";

import type { Feature, FeatureResult } from "@features/types";
import { readSecureTextFile, safeErrorMessage } from "@core/security";
import {
  astNodeSchema,
  codeMetricsSchema,
  createFeatureResultSchema,
  exportSchema,
  importSchema,
  symbolSchema,
} from "@features/utils";

export const analyzeFileSchema = z.object({
  file_path: z.string().describe("Path to the file to analyze"),
  include_ast: z
    .boolean()
    .default(false)
    .describe("Include full AST in response (default: false, can be verbose)"),
  include_symbols: z
    .boolean()
    .default(true)
    .describe("Include extracted symbols (default: true)"),
  include_imports: z
    .boolean()
    .default(true)
    .describe("Include import statements (default: true)"),
  include_exports: z
    .boolean()
    .default(true)
    .describe("Include export statements (default: true)"),
  ast_max_depth: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .default(5)
    .describe("Maximum depth for AST if included (default: 5)"),
  ast_max_nodes: z
    .number()
    .int()
    .positive()
    .max(100_000)
    .optional()
    .default(10_000)
    .describe("Maximum AST nodes if included (default: 10000)"),
  include_chunks: z
    .boolean()
    .default(false)
    .describe("Include text chunks for fallback parsing (default: false)"),
  redact_secrets: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Redact common secrets in structured source fields (default: true)",
    ),
});

export type AnalyzeFileInput = z.input<typeof analyzeFileSchema>;

const fallbackSymbolSchema = z
  .object({
    name: z.string(),
    type: z.enum([
      "function",
      "method",
      "class",
      "interface",
      "module",
      "variable",
    ]),
    line: z.number().int().positive(),
    endLine: z.number().int().positive().optional(),
    signature: z.string().optional(),
    documentation: z.string().optional(),
  })
  .strict();

const analyzeFileDataSchema = z
  .object({
    file_path: z.string(),
    source_is_untrusted: z.literal(true),
    language: z.string(),
    grammar: z
      .object({
        asset: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        bytes: z.number().int().positive(),
      })
      .strict()
      .optional(),
    parsing_method: z.enum(["tree-sitter", "langchain", "generic"]),
    capabilities: z.string().array(),
    metrics: codeMetricsSchema,
    symbols: z
      .union([symbolSchema.array(), fallbackSymbolSchema.array()])
      .optional(),
    imports: importSchema.array().optional(),
    exports: exportSchema.array().optional(),
    ast: astNodeSchema.optional(),
    symbol_extraction_method: z.enum(["tree-sitter", "regex"]).optional(),
    chunks: z
      .object({
        index: z.number().int().nonnegative(),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        preview: z.string(),
      })
      .strict()
      .array()
      .optional(),
    chunk_count: z.number().int().nonnegative().optional(),
    note: z.string().optional(),
    secrets_redacted: z.boolean(),
  })
  .strict();

export const analyzeFileOutputSchema = createFeatureResultSchema(
  analyzeFileDataSchema,
);

export async function execute(
  rawInput: AnalyzeFileInput,
): Promise<FeatureResult> {
  // Parse with defaults applied
  const input = analyzeFileSchema.parse(rawInput);
  const {
    file_path,
    include_ast,
    include_symbols,
    include_imports,
    include_exports,
    ast_max_depth,
    ast_max_nodes,
    include_chunks,
    redact_secrets,
  } = input;

  try {
    const secureFile = readSecureTextFile(file_path);
    if (!secureFile.ok) {
      return {
        success: false,
        error: `Cannot parse file: ${secureFile.error}`,
      };
    }
    const safeFilePath = secureFile.path;

    // Check if file can be parsed
    if (!canParse(safeFilePath)) {
      return { success: false, error: "Cannot parse binary file" };
    }

    // Get parsing capabilities for this file
    const capabilities = getParsingCapabilities(safeFilePath);

    // Parse the file with automatic fallback
    const parseResult = await parseFile(safeFilePath, {
      includeAst: include_ast,
      astMaxDepth: ast_max_depth,
      astMaxNodes: ast_max_nodes,
    });

    // If parsing failed (unsupported file type), return error
    if (!parseResult) {
      return {
        success: false,
        error: "Cannot parse file: unsupported or unreadable file type",
      };
    }

    // Build response based on parsing method
    const response: Record<string, unknown> = {
      file_path: safeFilePath,
      source_is_untrusted: true,
      language: parseResult.language,
      parsing_method: parseResult.method,
      ...(parseResult.grammar === undefined
        ? {}
        : { grammar: parseResult.grammar }),
      capabilities: capabilities.features,
      metrics: {
        lines: parseResult.lineCount,
        functions: 0,
        classes: 0,
        imports: 0,
        exports: 0,
      },
    };

    // Tree-sitter path - full analysis
    if (
      parseResult.method === "tree-sitter" &&
      parseResult.tree &&
      parseResult.languageInstance
    ) {
      const codeInfo = extractCodeInfo(
        parseResult.tree,
        parseResult.languageInstance,
        parseResult.language,
      );

      response.metrics = {
        lines: parseResult.lineCount,
        functions: codeInfo.symbols.summary.functions,
        classes: codeInfo.symbols.summary.classes,
        imports: codeInfo.imports.length,
        exports: codeInfo.exports.length,
      };

      if (include_symbols) {
        response.symbols = codeInfo.symbols.symbols;
      }

      if (include_imports) {
        response.imports = codeInfo.imports;
      }

      if (include_exports) {
        response.exports = codeInfo.exports;
      }

      if (include_ast) {
        response.ast = getASTRoot(
          { tree: parseResult.tree },
          ast_max_depth,
          undefined,
          ast_max_nodes,
        );
      }
    } else {
      // Fallback path - limited analysis
      const symbols = extractSymbols(parseResult);

      response.metrics = {
        lines: parseResult.lineCount,
        functions: symbols.functions.length,
        classes: symbols.classes.length,
        imports: 0, // Not available in fallback
        exports: 0, // Not available in fallback
      };

      if (include_symbols) {
        response.symbols = symbols.all;
        response.symbol_extraction_method = symbols.method;
      }

      if (include_chunks && parseResult.chunks) {
        response.chunks = parseResult.chunks.map((chunk) => ({
          index: chunk.index,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          preview:
            chunk.content.slice(0, 100) +
            (chunk.content.length > 100 ? "..." : ""),
        }));
        response.chunk_count = parseResult.chunks.length;
      }

      // Note about limited analysis
      response.note = `File parsed using ${parseResult.method} fallback. Some features (imports, exports, full AST) are not available.`;
    }

    // Build summary message
    const metrics = response.metrics as Record<string, number>;
    const methodNote =
      parseResult.method !== "tree-sitter" ? ` [${parseResult.method}]` : "";
    const summary = [
      `${parseResult.language} file${methodNote}`,
      `${String(metrics.lines)} lines`,
      `${String(metrics.functions)} functions`,
      `${String(metrics.classes)} classes`,
    ];

    if (parseResult.method === "tree-sitter") {
      summary.push(`${String(metrics.imports)} imports`);
      summary.push(`${String(metrics.exports)} exports`);
    }

    const redacted = redact_secrets
      ? redactStructuredValue(response)
      : { value: response, redacted: false };
    const safeResponse = {
      ...(redacted.value as Record<string, unknown>),
      secrets_redacted: redacted.redacted,
    };

    return {
      success: true,
      data: safeResponse,
      message: `Analyzed ${safeFilePath}: ${summary.join(", ")}`,
    };
  } catch (error) {
    const message = safeErrorMessage(error, "File analysis failed");
    return {
      success: false,
      error: `Failed to analyze file: ${message}`,
    };
  }
}

export const analyzeFileFeature: Feature<typeof analyzeFileSchema> = {
  name: "analyze_file",
  description:
    "Perform a comprehensive analysis of a source code file. Returns symbols, imports, exports, and code metrics. Optionally includes the full AST.",
  schema: analyzeFileSchema,
  outputSchema: analyzeFileOutputSchema,
  execute,
};
