import { z } from "zod";

import { countNodes, getASTRoot, parseCode } from "@core/parser";
import { redactStructuredValue } from "@core/security";

import type { Feature, FeatureResult } from "@features/types";
import { errorResult, readContent, successResult } from "@features/utils";
import { astNodeSchema, createFeatureResultSchema } from "@features/utils";

export const parseAstSchema = z
  .object({
    file_path: z
      .string()
      .optional()
      .describe(
        "Path to the file to parse (either file_path or content required)",
      ),
    content: z
      .string()
      .optional()
      .describe(
        "Code content to parse directly (either file_path or content required)",
      ),
    language: z
      .string()
      .optional()
      .describe("Language name (auto-detected from file path if not provided)"),
    max_depth: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .default(5)
      .describe("Maximum depth of AST to return (default: 5)"),
    max_text_bytes: z
      .number()
      .int()
      .positive()
      .max(20_000)
      .optional()
      .default(2_000)
      .describe("Maximum UTF-8 text retained per AST node (default: 2000)"),
    redact_secrets: z
      .boolean()
      .optional()
      .default(true)
      .describe("Redact common secrets in AST text fields (default: true)"),
    max_nodes: z
      .number()
      .int()
      .positive()
      .max(100_000)
      .optional()
      .default(10_000)
      .describe(
        "Maximum AST nodes materialized in the response (default: 10000)",
      ),
  })
  .refine((data) => data.file_path ?? data.content, {
    message: "Either file_path or content must be provided",
  });

export type ParseAstInput = z.input<typeof parseAstSchema>;

const parseAstDataSchema = z
  .object({
    language: z.string(),
    grammar: z
      .object({
        asset: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        bytes: z.number().int().positive(),
      })
      .strict()
      .optional(),
    root: astNodeSchema,
    node_count: z.number().int().nonnegative(),
    text_max_bytes: z.number().int().positive(),
    max_nodes: z.number().int().positive(),
    node_count_truncated: z.boolean(),
    source_is_untrusted: z.literal(true),
    secrets_redacted: z.boolean(),
  })
  .strict();

export const parseAstOutputSchema =
  createFeatureResultSchema(parseAstDataSchema);

export async function execute(input: ParseAstInput): Promise<FeatureResult> {
  const parsedInput = parseAstSchema.parse(input);
  const {
    file_path,
    content: inputContent,
    language,
    max_depth,
    max_text_bytes,
    redact_secrets,
    max_nodes,
  } = parsedInput;

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

    // Get AST root with optional depth limit
    const root = getASTRoot(parseResult, max_depth, max_text_bytes, max_nodes);

    // Count nodes directly from the tree (accurate regardless of max_depth)
    const observedNodeCount = countNodes(
      parseResult.tree.rootNode,
      max_nodes + 1,
    );
    const nodeCount = Math.min(observedNodeCount, max_nodes);

    const data = {
      language: parseResult.language,
      ...(parseResult.grammar === undefined
        ? {}
        : { grammar: parseResult.grammar }),
      root,
      node_count: nodeCount,
      text_max_bytes: max_text_bytes,
      max_nodes,
      node_count_truncated: observedNodeCount > max_nodes,
      source_is_untrusted: true,
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
      `Parsed ${parseResult.language} code with ${String(nodeCount)} nodes`,
    );
  } catch (error) {
    return errorResult("parse", error);
  }
}

export const parseAstFeature: Feature<typeof parseAstSchema> = {
  name: "parse_ast",
  description:
    "Parse code and return the Abstract Syntax Tree (AST). Supports multiple languages including JavaScript, TypeScript, Python, Go, Rust, Java, C, C++, and more.",
  schema: parseAstSchema,
  outputSchema: parseAstOutputSchema,
  execute,
};
