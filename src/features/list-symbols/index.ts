import { z } from "zod";

import { parseCode } from "@core/parser";
import { extractSymbols, type SymbolFilter } from "@core/symbols";

import type { Feature, FeatureResult } from "@features/types";
import {
  createFeatureResultSchema,
  errorResult,
  readContent,
  successResult,
  symbolSchema,
} from "@features/utils";

const symbolTypeValues = [
  "function",
  "class",
  "variable",
  "constant",
  "interface",
  "type",
  "enum",
  "method",
  "property",
] as const;

export const listSymbolsSchema = z
  .object({
    file_path: z
      .string()
      .optional()
      .describe("Path to the file to analyze (either file_path or content required)"),
    content: z
      .string()
      .optional()
      .describe("Code content to analyze directly (either file_path or content required)"),
    language: z
      .string()
      .optional()
      .describe("Language name (auto-detected from file path if not provided)"),
    types: z
      .array(z.enum(symbolTypeValues))
      .optional()
      .describe(
        "Filter by symbol types: function, class, variable, constant, interface, type, enum, method, property",
      ),
    max_symbols: z
      .number()
      .int()
      .positive()
      .max(5000)
      .optional()
      .default(1000)
      .describe("Maximum symbols returned (default: 1000)"),
  })
  .refine((data) => data.file_path ?? data.content, {
    message: "Either file_path or content must be provided",
  });

export type ListSymbolsInput = z.input<typeof listSymbolsSchema>;

const symbolSummarySchema = z
  .object({
    functions: z.number().int().nonnegative(),
    classes: z.number().int().nonnegative(),
    variables: z.number().int().nonnegative(),
    constants: z.number().int().nonnegative(),
    interfaces: z.number().int().nonnegative(),
    types: z.number().int().nonnegative(),
    enums: z.number().int().nonnegative(),
    methods: z.number().int().nonnegative(),
    properties: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();

const listSymbolsDataSchema = z
  .object({
    symbols: symbolSchema.array(),
    summary: symbolSummarySchema,
    language: z.string(),
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
    source_is_untrusted: z.literal(true),
  })
  .strict();

export const listSymbolsOutputSchema = createFeatureResultSchema(listSymbolsDataSchema);

export async function execute(input: ListSymbolsInput): Promise<FeatureResult> {
  const parsedInput = listSymbolsSchema.parse(input);
  const { file_path, content: inputContent, language, types, max_symbols } = parsedInput;

  // Get content using shared helper
  const contentResult = readContent(file_path, inputContent);
  if (!contentResult.success) {
    return { success: false, error: contentResult.error };
  }

  try {
    const safeFilePath = contentResult.filePath ?? file_path;

    // Parse the code
    const parseResult = await parseCode(contentResult.content, {
      language,
      filePath: safeFilePath,
    });

    // Build filter
    const filter: SymbolFilter = {};
    if (types && types.length > 0) {
      filter.types = types;
    }

    // Extract symbols
    const { symbols, summary } = extractSymbols(
      parseResult.tree,
      parseResult.languageInstance,
      parseResult.language,
      filter,
    );

    return successResult(
      {
        symbols: symbols.slice(0, max_symbols),
        summary,
        language: parseResult.language,
        total: symbols.length,
        truncated: symbols.length > max_symbols,
        source_is_untrusted: true,
      },
      `Found ${String(summary.total)} symbol${summary.total === 1 ? "" : "s"} in ${parseResult.language} code`,
    );
  } catch (error) {
    return errorResult("extract symbols", error);
  }
}

export const listSymbolsFeature: Feature<typeof listSymbolsSchema> = {
  name: "list_symbols",
  description:
    "Extract all code symbols (functions, classes, variables, etc.) from a file. Returns structured information including name, type, location, and signature for each symbol.",
  schema: listSymbolsSchema,
  outputSchema: listSymbolsOutputSchema,
  execute,
};
