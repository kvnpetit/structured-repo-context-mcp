import { z } from "zod";

import type { Feature, FeatureAnnotations } from "@features/types";
import { createFeatureResultSchema } from "@features/utils";

const MUTATING_FEATURE_NAMES = new Set<string>([
  "index_codebase",
  "update_index",
  "set_project_memory",
  "refresh_project_catalog",
  "manage_index_snapshots",
  "import_scip_index",
  "maintain_index",
]);

const genericFeatureResultSchema = createFeatureResultSchema(z.unknown());

export interface FeatureToolConfig {
  title: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  annotations: Required<FeatureAnnotations>;
}

function isObjectUnion(
  schema: z.ZodType,
): schema is z.ZodUnion | z.ZodDiscriminatedUnion {
  return (
    (schema instanceof z.ZodUnion ||
      schema instanceof z.ZodDiscriminatedUnion) &&
    schema.options.every((option) => option instanceof z.ZodObject)
  );
}

function flattenObjectUnion(schema: z.ZodType): z.ZodType | undefined {
  if (!isObjectUnion(schema)) {
    return undefined;
  }
  const options = (schema as unknown as { options: readonly z.ZodObject[] })
    .options;
  const keys = [
    ...new Set(
      options.flatMap((option) => Object.keys(option.shape as object)),
    ),
  ];
  const shape: Record<string, z.ZodType> = {};
  for (const key of keys) {
    const fields = options.flatMap((option) => {
      const optionShape = option.shape as Record<string, z.ZodType>;
      return optionShape[key] === undefined ? [] : [optionShape[key]];
    });
    const firstField = fields[0];
    if (firstField === undefined) {
      continue;
    }
    const combined =
      fields.length === 1
        ? firstField
        : z.union(fields as [z.ZodType, z.ZodType, ...z.ZodType[]]);
    const requiredInEveryOption =
      fields.length === options.length &&
      fields.every((field) => !field.safeParse(undefined).success);
    shape[key] = requiredInEveryOption ? combined : combined.optional();
  }
  return z.object(shape).superRefine((value, context) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
      }
    }
  });
}

export function toMcpInputSchema(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) {
    return schema;
  }
  return flattenObjectUnion(schema) ?? z.object({ input: schema });
}

export function usesFlatMcpInput(schema: z.ZodType): boolean {
  return schema instanceof z.ZodObject || isObjectUnion(schema);
}

export function isMutatingFeatureName(name: string): boolean {
  return MUTATING_FEATURE_NAMES.has(name);
}

export function resolveFeatureAnnotations(
  feature: Feature,
): Required<FeatureAnnotations> {
  return {
    title: feature.annotations?.title ?? feature.title ?? feature.name,
    readOnlyHint:
      feature.annotations?.readOnlyHint ?? !isMutatingFeatureName(feature.name),
    destructiveHint: feature.annotations?.destructiveHint ?? false,
    idempotentHint: feature.annotations?.idempotentHint ?? true,
    openWorldHint: feature.annotations?.openWorldHint ?? false,
  };
}

export function createFeatureToolConfig(feature: Feature): FeatureToolConfig {
  return {
    title: feature.title ?? feature.name,
    description: feature.description,
    inputSchema: toMcpInputSchema(feature.schema),
    outputSchema: feature.outputSchema ?? genericFeatureResultSchema,
    annotations: resolveFeatureAnnotations(feature),
  };
}
