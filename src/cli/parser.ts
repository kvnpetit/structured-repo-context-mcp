import type { ArgDef, ArgsDef } from "citty";
import { z } from "zod";

interface CliField {
  schemas: z.ZodType[];
  required: boolean;
}

function objectOptions(schema: z.ZodType): z.ZodObject[] {
  if (schema instanceof z.ZodObject) {
    return [schema];
  }
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    const options = schema.options.filter(
      (option): option is z.ZodObject => option instanceof z.ZodObject,
    );
    return options.length === schema.options.length ? options : [];
  }
  return [];
}

function cliFields(schema: z.ZodType): Map<string, CliField> {
  const options = objectOptions(schema);
  const fields = new Map<string, CliField>();
  for (const option of options) {
    const shape: unknown = option.shape;
    if (typeof shape !== "object" || shape === null) {
      continue;
    }
    for (const [key, fieldSchema] of Object.entries(shape)) {
      if (!(fieldSchema instanceof z.ZodType)) {
        continue;
      }
      const current = fields.get(key);
      if (current === undefined) {
        fields.set(key, { schemas: [fieldSchema], required: false });
      } else {
        current.schemas.push(fieldSchema);
      }
    }
  }
  for (const [key, field] of fields) {
    field.required =
      field.schemas.length === options.length &&
      field.schemas.every((fieldSchema) => !fieldSchema.safeParse(undefined).success);
    fields.set(key, field);
  }
  return fields;
}

function unwrap(schema: z.ZodType): z.ZodType {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodNonOptional
  ) {
    return unwrap(schema.unwrap() as z.ZodType);
  }
  return schema;
}

function descriptionOf(schemas: readonly z.ZodType[]): string | undefined {
  for (const schema of schemas) {
    if (schema.description !== undefined) {
      return schema.description;
    }
    const innerDescription = unwrap(schema).description;
    if (innerDescription !== undefined) {
      return innerDescription;
    }
  }
  return undefined;
}

function defaultOf(schemas: readonly z.ZodType[]): unknown {
  const defaults = schemas.map((schema) => {
    const parsed = schema.safeParse(undefined);
    return parsed.success ? parsed.data : undefined;
  });
  const first = defaults[0];
  return defaults.length > 0 && defaults.every((value) => value === first) ? first : undefined;
}

function enumOptions(schemas: readonly z.ZodType[]): string[] | undefined {
  const values = new Set<string>();
  for (const schema of schemas) {
    const base = unwrap(schema);
    if (base instanceof z.ZodEnum) {
      for (const value of base.options) {
        if (typeof value !== "string") {
          return undefined;
        }
        values.add(value);
      }
    } else if (base instanceof z.ZodLiteral && typeof base.value === "string") {
      values.add(base.value);
    } else {
      return undefined;
    }
  }
  return values.size > 0 ? [...values] : undefined;
}

function createArgDef(field: CliField): ArgDef {
  const description = descriptionOf(field.schemas);
  const defaultValue = defaultOf(field.schemas);
  const baseSchemas = field.schemas.map(unwrap);
  const options = enumOptions(field.schemas);
  const common = {
    ...(description === undefined ? {} : { description }),
    required: field.required,
  };

  if (baseSchemas.every((schema) => schema instanceof z.ZodBoolean)) {
    return {
      type: "boolean",
      ...common,
      ...(typeof defaultValue === "boolean" ? { default: defaultValue } : {}),
    };
  }
  if (options !== undefined) {
    return {
      type: "enum",
      options,
      ...common,
      ...(typeof defaultValue === "string" ? { default: defaultValue } : {}),
    };
  }
  return {
    type: "string",
    ...common,
    ...(typeof defaultValue === "string"
      ? { default: defaultValue }
      : typeof defaultValue === "number"
        ? { default: String(defaultValue) }
        : {}),
  };
}

/** Convert an object or object-union Zod schema to Citty arguments. */
export function zodToCittyArgs(schema: z.ZodType): ArgsDef {
  return Object.fromEntries(
    [...cliFields(schema)].map(([key, field]) => [key, createArgDef(field)]),
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function coerceArray(value: string, schema: z.ZodArray): unknown[] {
  const parsedJson = parseJson(value);
  const values = Array.isArray(parsedJson)
    ? parsedJson
    : value.length === 0
      ? []
      : value.split(",").map((entry) => entry.trim());
  return values.map((entry) => coerceFieldValue(entry, [schema.element as z.ZodType]));
}

function candidateValues(value: unknown, schemas: readonly z.ZodType[]): unknown[] {
  const candidates: unknown[] = [value];
  if (typeof value !== "string") {
    return candidates;
  }
  const bases = schemas.map(unwrap);
  if (bases.some((schema) => schema instanceof z.ZodNumber)) {
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) {
      candidates.push(numberValue);
    }
  }
  for (const schema of bases) {
    if (schema instanceof z.ZodArray) {
      candidates.push(coerceArray(value, schema));
    } else if (
      schema instanceof z.ZodObject ||
      schema instanceof z.ZodRecord ||
      schema instanceof z.ZodTuple
    ) {
      const json = parseJson(value);
      if (json !== undefined) {
        candidates.push(json);
      }
    }
  }
  return candidates;
}

function coerceFieldValue(value: unknown, schemas: readonly z.ZodType[]): unknown {
  for (const candidate of candidateValues(value, schemas)) {
    if (schemas.some((schema) => schema.safeParse(candidate).success)) {
      return candidate;
    }
  }
  return value;
}

/** Convert Citty's string-oriented result into values accepted by Zod. */
export function normalizeCliArgs(
  schema: z.ZodType,
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const fields = cliFields(schema);
  const normalized: Record<string, unknown> = {};
  for (const [key, field] of fields) {
    const value = args[key];
    if (value !== undefined) {
      normalized[key] = coerceFieldValue(value, field.schemas);
    }
  }
  return normalized;
}
