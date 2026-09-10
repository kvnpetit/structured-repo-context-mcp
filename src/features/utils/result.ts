/**
 * Result building utilities for features
 *
 * Provides consistent result construction patterns
 */
import { safeErrorMessage } from "@core/security";
import type { FeatureResult } from "@features/types";
import { z } from "zod";
import { instructionSignalsSchema } from "./schemas";

const FEATURE_RESULT_SCHEMA_VERSION = 1 as const;

export const featureResultMetaSchema = z
  .object({
    generated_at: z.string(),
    local_only: z.literal(true),
    bounded: z.literal(true),
    provenance: z.enum(["local-analysis", "local-filesystem", "local-index", "local-lsp"]),
    source_is_untrusted: z.boolean().optional(),
    source_revision: z.string().optional(),
    index_freshness: z.enum(["fresh", "stale", "unknown"]).optional(),
    truncated: z.boolean().optional(),
    confidence: z.number().min(0).max(1).optional(),
    coverage: z.enum(["precise", "approximate", "unknown"]).optional(),
    instruction_signals: instructionSignalsSchema.optional(),
  })
  .strict();

/** Build the strict protocol envelope used by MCP tools with typed data. */
export function createFeatureResultSchema(dataSchema: z.ZodType): z.ZodType {
  return z
    .object({
      schema_version: z.literal(FEATURE_RESULT_SCHEMA_VERSION),
      success: z.boolean(),
      meta: featureResultMetaSchema,
      data: dataSchema.optional(),
      message: z.string().optional(),
      error: z.string().optional(),
    })
    .strict();
}

/**
 * Create an error result with consistent formatting
 *
 * @param action - Description of what failed (e.g., "parse file", "execute query")
 * @param error - The error that occurred
 * @returns FeatureResult with success: false
 */
export function errorResult(action: string, error: unknown): FeatureResult {
  const message = safeErrorMessage(error, "operation failed");
  return {
    success: false,
    error: `Failed to ${action}: ${message}`,
  };
}

/**
 * Create a simple error result with a custom message
 *
 * @param error - The error message
 * @returns FeatureResult with success: false
 */
export function errorMessage(error: string): FeatureResult {
  return {
    success: false,
    error,
  };
}

/**
 * Create a success result with data and optional message
 *
 * @param data - The data to return
 * @param message - Optional success message
 * @returns FeatureResult with success: true
 */
export function successResult(data: unknown, message?: string): FeatureResult {
  return {
    success: true,
    data,
    message,
  };
}

/**
 * Create a success result with just a message (no data)
 *
 * @param message - The success message
 * @returns FeatureResult with success: true
 */
export function successMessage(message: string): FeatureResult {
  return {
    success: true,
    message,
  };
}
