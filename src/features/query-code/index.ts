import { z } from "zod";

import { parseCode } from "@core/parser";
import { redactStructuredValue } from "@core/security";
import {
  executePresetQuery,
  executeQuery,
  getAvailablePresets,
  type QueryResult,
} from "@core/queries";

import type { Feature, FeatureResult } from "@features/types";
import {
  astNodeSchema,
  createFeatureResultSchema,
  errorMessage,
  errorResult,
  readContent,
  successResult,
} from "@features/utils";

const presetValues = [
  "functions",
  "classes",
  "imports",
  "exports",
  "comments",
  "strings",
  "variables",
  "types",
] as const;

export const queryCodeSchema = z
  .object({
    file_path: z
      .string()
      .optional()
      .describe("Path to the file to query (either file_path or content required)"),
    content: z
      .string()
      .optional()
      .describe("Code content to query directly (either file_path or content required)"),
    language: z
      .string()
      .optional()
      .describe("Language name (auto-detected from file path if not provided)"),
    query: z.string().optional().describe("SCM query pattern (either query or preset required)"),
    preset: z
      .enum(presetValues)
      .optional()
      .describe(
        "Preset query name: functions, classes, imports, exports, comments, strings, variables, types",
      ),
    max_matches: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .describe("Maximum number of matches to return (default: 500)"),
    redact_secrets: z
      .boolean()
      .optional()
      .default(true)
      .describe("Redact common secrets in query match text (default: true)"),
  })
  .refine((data) => data.file_path ?? data.content, {
    message: "Either file_path or content must be provided",
  })
  .refine((data) => data.query ?? data.preset, {
    message: "Either query or preset must be provided",
  });

export type QueryCodeInput = z.input<typeof queryCodeSchema>;

const queryMatchSchema = z
  .object({
    pattern: z.number().int().nonnegative(),
    captures: z.object({ name: z.string(), node: astNodeSchema }).strict().array(),
  })
  .strict();

const queryCodeDataSchema = z
  .object({
    matches: queryMatchSchema.array(),
    count: z.number().int().nonnegative(),
    available_count: z.number().int().nonnegative(),
    truncated: z.boolean(),
    source_is_untrusted: z.literal(true),
    language: z.string(),
    query: z.string(),
    secrets_redacted: z.boolean(),
  })
  .strict();

export const queryCodeOutputSchema = createFeatureResultSchema(queryCodeDataSchema);

export async function execute(rawInput: QueryCodeInput): Promise<FeatureResult> {
  const input = queryCodeSchema.parse(rawInput);
  const {
    file_path,
    content: inputContent,
    language,
    query,
    preset,
    max_matches,
    redact_secrets,
  } = input;
  const effectiveMaxMatches = max_matches ?? 500;

  // Get content
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

    // Execute query
    let result: QueryResult;
    if (preset) {
      // Check if preset is available for this language
      const availablePresets = getAvailablePresets(parseResult.language);
      if (!availablePresets.includes(preset)) {
        return errorMessage(
          `Preset '${preset}' is not available for ${parseResult.language}. Available presets: ${availablePresets.join(", ")}`,
        );
      }

      result = executePresetQuery(
        parseResult.tree,
        parseResult.languageInstance,
        parseResult.language,
        preset,
        { maxMatches: effectiveMaxMatches + 1 },
      );
    } else if (query) {
      result = executeQuery(
        parseResult.tree,
        parseResult.languageInstance,
        query,
        parseResult.language,
        { maxMatches: effectiveMaxMatches + 1 },
      );
    } else {
      return errorMessage("Either query or preset must be provided");
    }

    const matches = result.matches.slice(0, effectiveMaxMatches);
    const truncated = result.matches.length > effectiveMaxMatches;
    const data = {
      matches,
      count: matches.length,
      available_count: result.count,
      truncated,
      source_is_untrusted: true,
      language: result.language,
      query: result.query,
    };
    const redacted = redact_secrets
      ? redactStructuredValue(data)
      : { value: data, redacted: false };
    const safeData = {
      ...(redacted.value as Record<string, unknown>),
      secrets_redacted: redacted.redacted,
    };

    return successResult(
      safeData,
      `Found ${String(matches.length)} match${matches.length === 1 ? "" : "es"} in ${parseResult.language} code${truncated ? " (truncated)" : ""}`,
    );
  } catch (error) {
    return errorResult("query", error);
  }
}

export const queryCodeFeature: Feature<typeof queryCodeSchema> = {
  name: "query_code",
  description:
    "Execute Tree-sitter SCM queries on code to find patterns. Use preset queries (functions, classes, imports, exports, comments, strings, variables, types) or custom SCM query patterns.",
  schema: queryCodeSchema,
  outputSchema: queryCodeOutputSchema,
  execute,
};
