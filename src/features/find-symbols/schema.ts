import { z } from "zod";

import type { Position } from "@core/ast/types";
import type { InstructionSignals } from "@core/security";
import {
  createFeatureResultSchema,
  instructionSignalsSchema,
} from "@features/utils";

const navigationModes = [
  "definitions",
  "references",
  "imports",
  "exports",
  "all",
] as const;

export const findSymbolsSchema = z.object({
  directory: z
    .string()
    .optional()
    .default(".")
    .describe("Project directory to inspect"),
  file_path: z
    .string()
    .optional()
    .describe("Optional file path, relative to directory"),
  query: z
    .string()
    .optional()
    .default("")
    .describe("Symbol or module text to find; empty lists all definitions"),
  mode: z
    .enum(navigationModes)
    .optional()
    .default("definitions")
    .describe("What to return"),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .default(50)
    .describe("Maximum matches"),
  cursor: z
    .string()
    .max(1_024)
    .optional()
    .describe("Opaque cursor returned by a previous page"),
  max_files: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .default(200)
    .describe("Maximum files to parse"),
  redact_secrets: z
    .boolean()
    .optional()
    .default(true)
    .describe("Redact common secrets in returned snippets (default: true)"),
});

export type FindSymbolsInput = z.input<typeof findSymbolsSchema>;

export interface NavigationMatch {
  kind: "definition" | "reference" | "import" | "export";
  name: string;
  type?: string;
  file_path: string;
  start: Position;
  end: Position;
  snippet: string;
  source?: string;
  signature?: string;
}

export interface NavigationOutput {
  query: string;
  mode: (typeof navigationModes)[number];
  files_analyzed: number;
  files_truncated: boolean;
  truncated: boolean;
  matches: NavigationMatch[];
  next_cursor?: string;
  cursor_offset: number;
  source_is_untrusted: true;
  secrets_redacted: boolean;
  instruction_signals: InstructionSignals;
  errors: string[];
}

const positionSchema = z
  .object({ line: z.number(), column: z.number(), offset: z.number() })
  .strict();
const navigationMatchSchema = z
  .object({
    kind: z.enum(["definition", "reference", "import", "export"]),
    name: z.string(),
    type: z.string().optional(),
    file_path: z.string(),
    start: positionSchema,
    end: positionSchema,
    snippet: z.string(),
    source: z.string().optional(),
    signature: z.string().optional(),
  })
  .strict();
const findSymbolsDataSchema = z
  .object({
    query: z.string(),
    mode: z.enum(navigationModes),
    files_analyzed: z.number().int().nonnegative(),
    files_truncated: z.boolean(),
    truncated: z.boolean(),
    matches: navigationMatchSchema.array(),
    next_cursor: z.string().optional(),
    cursor_offset: z.number().int().nonnegative(),
    source_is_untrusted: z.literal(true),
    secrets_redacted: z.boolean(),
    instruction_signals: instructionSignalsSchema,
    errors: z.string().array(),
  })
  .strict();

export const findSymbolsOutputSchema = createFeatureResultSchema(
  findSymbolsDataSchema,
);
