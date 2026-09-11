import type { z } from "zod";
import type { InstructionSignals } from "@core/security";

/**
 * Stable metadata carried by every protocol-level feature response.
 * Values describe local evidence returned by the tool; they never grant
 * authority to source text or instructions embedded in that evidence.
 */
export interface FeatureResultMetadata {
  generated_at: string;
  local_only: true;
  bounded: true;
  provenance: "local-analysis" | "local-filesystem" | "local-index" | "local-lsp";
  source_is_untrusted?: boolean;
  source_revision?: string;
  index_freshness?: "fresh" | "stale" | "unknown";
  truncated?: boolean;
  confidence?: number;
  coverage?: "precise" | "approximate" | "unknown";
  instruction_signals?: InstructionSignals;
}

export interface FeatureResult {
  success: boolean;
  data?: unknown;
  message?: string;
  error?: string;
  meta?: Partial<FeatureResultMetadata>;
}

export interface FeatureAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface FeatureExecutionContext {
  /** Abort signal propagated from the MCP request/transport. */
  signal?: AbortSignal;
  /** Report bounded progress when the client supplied a progress token. */
  reportProgress?: (progress: number, total?: number, message?: string) => Promise<void>;
}

export interface Feature<TInput extends z.ZodType = z.ZodType> {
  name: string;
  title?: string;
  description: string;
  schema: TInput;
  /** Optional strict full MCP output schema; legacy features use the generic envelope. */
  outputSchema?: z.ZodType;
  annotations?: FeatureAnnotations;
  execute: (
    input: z.infer<TInput>,
    context?: FeatureExecutionContext,
  ) => FeatureResult | Promise<FeatureResult>;
}
