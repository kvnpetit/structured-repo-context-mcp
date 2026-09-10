import { z } from "zod";

/** Shared wire schemas for legacy and modern feature outputs. */
export const positionSchema = z
  .object({
    line: z.number().int().positive(),
    column: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .strict();

export const symbolTypeSchema = z.enum([
  "function",
  "class",
  "variable",
  "constant",
  "interface",
  "type",
  "enum",
  "method",
  "property",
]);

export const symbolSchema = z
  .object({
    name: z.string(),
    type: symbolTypeSchema,
    start: positionSchema,
    end: positionSchema,
    signature: z.string().optional(),
    modifiers: z.string().array().optional(),
    documentation: z.string().optional(),
  })
  .strict();

export const importedNameSchema = z
  .object({
    name: z.string(),
    alias: z.string().optional(),
  })
  .strict();

export const importSchema = z
  .object({
    source: z.string(),
    names: importedNameSchema.array(),
    isDefault: z.boolean().optional(),
    isNamespace: z.boolean().optional(),
    start: positionSchema,
    end: positionSchema,
  })
  .strict();

export const exportSchema = z
  .object({
    name: z.string(),
    isDefault: z.boolean().optional(),
    isReExport: z.boolean().optional(),
    source: z.string().optional(),
    start: positionSchema,
    end: positionSchema,
  })
  .strict();

/**
 * AST output is recursive by design. The object itself remains strict while
 * named fields are represented as a bounded map of AST nodes.
 */
export const astNodeSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      type: z.string(),
      text: z.string(),
      text_truncated: z.boolean().optional(),
      children_truncated: z.boolean().optional(),
      start: positionSchema,
      end: positionSchema,
      children: astNodeSchema.array().optional(),
      fields: z.record(z.string(), z.union([astNodeSchema, astNodeSchema.array()])).optional(),
      isNamed: z.boolean().optional(),
    })
    .strict(),
);

export const codeMetricsSchema = z
  .object({
    lines: z.number().int().nonnegative(),
    functions: z.number().int().nonnegative(),
    classes: z.number().int().nonnegative(),
    imports: z.number().int().nonnegative(),
    exports: z.number().int().nonnegative(),
  })
  .strict();

export const instructionSignalKindSchema = z.enum([
  "instruction_override",
  "authority_spoofing",
  "tool_execution_request",
  "secret_exfiltration_request",
  "delimiter_spoofing",
  "hidden_unicode",
  "encoded_instruction",
]);

export const instructionSignalSchema = z
  .object({
    kind: instructionSignalKindSchema,
    source: z.string().optional(),
    line: z.number().int().positive(),
    column: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    confidence: z.number().min(0).max(1),
    reason: z.string(),
  })
  .strict();

export const instructionSignalsSchema = z
  .object({
    detected: z.boolean(),
    count: z.number().int().nonnegative(),
    kinds: instructionSignalKindSchema.array(),
    signals: instructionSignalSchema.array(),
    scanned_bytes: z.number().int().nonnegative(),
    scan_truncated: z.boolean(),
  })
  .strict();
