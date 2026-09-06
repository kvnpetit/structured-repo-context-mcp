import { getMaxResultBytes } from "@config";
import { metrics, recordAuditEvent } from "@core/observability";
import {
  scanInstructionSignals,
  type InstructionSignals,
} from "@core/security";
import { instructionSignalsSchema } from "@features/utils";
import type {
  Feature,
  FeatureExecutionContext,
  FeatureResult,
  FeatureResultMetadata,
} from "@features/types";

/** Version of the stable envelope returned by every feature adapter. */
export const FEATURE_RESULT_SCHEMA_VERSION = 1 as const;

export interface FormattedFeatureResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError: boolean;
  structuredContent: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function resultMetadata(
  data: unknown,
  override: Partial<FeatureResultMetadata> | undefined,
): FeatureResultMetadata {
  const record = asRecord(data);
  const index = asRecord(record?.index);
  const sourceRevision = [
    record?.source_revision,
    record?.source_fingerprint,
    record?.profile_fingerprint,
    index?.source_fingerprint,
  ].find((value): value is string => typeof value === "string");
  const provenance: FeatureResultMetadata["provenance"] =
    record?.backend_used === "lsp"
      ? "local-lsp"
      : index !== undefined
        ? "local-index"
        : record?.directory !== undefined
          ? "local-filesystem"
          : "local-analysis";
  const embeddedSignals = instructionSignalsSchema.safeParse(
    record?.instruction_signals,
  );
  let instructionSignals: InstructionSignals | undefined =
    embeddedSignals.success ? embeddedSignals.data : undefined;
  if (instructionSignals === undefined) {
    try {
      const serialized = JSON.stringify(data);
      if (typeof serialized === "string") {
        const detected = scanInstructionSignals(serialized, {
          maxBytes: 200_000,
        });
        if (detected.detected || detected.scan_truncated) {
          instructionSignals = detected;
        }
      }
    } catch {
      // Metadata enrichment must never make a feature response fail.
    }
  }
  const rawIndexFreshness = record?.index_freshness;
  const indexFreshness =
    rawIndexFreshness === "fresh" ||
    rawIndexFreshness === "stale" ||
    rawIndexFreshness === "unknown"
      ? rawIndexFreshness
      : undefined;
  const coverage = record?.coverage;
  return {
    generated_at: new Date().toISOString(),
    local_only: true,
    bounded: true,
    provenance,
    ...(typeof record?.source_is_untrusted === "boolean"
      ? { source_is_untrusted: record.source_is_untrusted }
      : {}),
    ...(sourceRevision === undefined
      ? {}
      : { source_revision: sourceRevision }),
    index_freshness: indexFreshness ?? "unknown",
    ...(typeof record?.truncated === "boolean"
      ? { truncated: record.truncated }
      : {}),
    ...(typeof record?.confidence === "number"
      ? { confidence: record.confidence }
      : {}),
    ...(coverage === "precise" || coverage === "approximate"
      ? { coverage }
      : {}),
    ...(instructionSignals === undefined
      ? {}
      : { instruction_signals: instructionSignals }),
    ...override,
  };
}

/** Execute a feature with the same metrics, audit, and safe-failure semantics. */
export async function executeFeature(
  feature: Feature,
  input: unknown,
  context?: FeatureExecutionContext,
): Promise<FeatureResult> {
  const startedAt = Date.now();
  try {
    const result = await feature.execute(input, context);
    const duration = Date.now() - startedAt;
    metrics.recordTool(feature.name, result.success, duration);
    const directory = asRecord(result.data)?.directory;
    await recordAuditEvent({
      tool: feature.name,
      success: result.success,
      duration_ms: duration,
      ...(typeof directory === "string" ? { directory } : {}),
    });
    return result;
  } catch {
    const duration = Date.now() - startedAt;
    metrics.recordTool(feature.name, false, duration);
    await recordAuditEvent({
      tool: feature.name,
      success: false,
      duration_ms: duration,
    });
    return { success: false, error: "Tool execution failed" };
  }
}

/** Build the stable, bounded result shared by MCP and CLI adapters. */
export function formatFeatureResult(
  result: FeatureResult,
): FormattedFeatureResult {
  const structuredContent = {
    schema_version: FEATURE_RESULT_SCHEMA_VERSION,
    success: result.success,
    meta: resultMetadata(result.data, result.meta),
    ...(result.data === undefined ? {} : { data: result.data }),
    ...(result.message === undefined ? {} : { message: result.message }),
    ...(result.error === undefined ? {} : { error: result.error }),
  };
  let text: string;
  if (result.message !== undefined) {
    text = result.message;
  } else if (result.error !== undefined) {
    text = result.error;
  } else {
    try {
      text = JSON.stringify(
        result.data ?? { success: result.success },
        null,
        2,
      );
    } catch {
      text = "Tool result could not be serialized";
    }
  }

  const response: FormattedFeatureResult = {
    content: [{ type: "text", text }],
    isError: !result.success,
    structuredContent,
  };
  try {
    if (
      Buffer.byteLength(JSON.stringify(response), "utf8") <= getMaxResultBytes()
    ) {
      return response;
    }
  } catch {
    // Fall through to the bounded, serializable error below.
  }

  return {
    content: [
      {
        type: "text",
        text: "Tool result exceeded the configured output limit",
      },
    ],
    isError: true,
    structuredContent: {
      schema_version: FEATURE_RESULT_SCHEMA_VERSION,
      success: false,
      meta: resultMetadata(undefined, undefined),
      error: "Tool result exceeded the configured output limit",
    },
  };
}

/** Apply the feature-specific output contract after common result formatting. */
export function finalizeFeatureResult(
  feature: Feature,
  result: FeatureResult,
): FormattedFeatureResult {
  const formatted = formatFeatureResult(result);
  if (
    feature.outputSchema === undefined ||
    feature.outputSchema.safeParse(formatted.structuredContent).success
  ) {
    return formatted;
  }
  return formatFeatureResult({
    success: false,
    error: "Tool returned an invalid structured output",
  });
}
