import { z } from "zod";

import { getAuditStatus, getMetricsSnapshot } from "@core/observability";
import { resolveSecureDirectory } from "@core/security";
import type { Feature, FeatureResult } from "@features/types";
import { createFeatureResultSchema } from "@features/utils";

const OBSERVABILITY_FORMATS = ["json", "prometheus"] as const;

export const observabilitySchema = z.object({
  directory: z.string().optional().default(".").describe("Project directory"),
  format: z
    .enum(OBSERVABILITY_FORMATS)
    .optional()
    .default("json")
    .describe("Return structured JSON data or a local Prometheus text export"),
});

export type ObservabilityInput = z.input<typeof observabilitySchema>;

const metricSchema = z
  .object({
    calls: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    totalDurationMs: z.number().nonnegative(),
    lastDurationMs: z.number().nonnegative(),
    p50DurationMs: z.number().nonnegative(),
    p95DurationMs: z.number().nonnegative(),
  })
  .strict();

const metricsSchema = z
  .object({
    startedAt: z.string(),
    tools: z.record(z.string(), metricSchema),
  })
  .strict();

const runtimeSchema = z
  .object({
    uptime_ms: z.number().int().nonnegative(),
    rss_bytes: z.number().int().nonnegative(),
    heap_used_bytes: z.number().int().nonnegative(),
    heap_total_bytes: z.number().int().nonnegative(),
  })
  .strict();

const auditSchema = z
  .object({
    enabled: z.boolean(),
    file: z.string(),
    events: z.number().int().nonnegative(),
    last_event_at: z.string().optional(),
  })
  .strict();

const observabilityDataSchema = z
  .object({
    directory: z.string(),
    format: z.enum(OBSERVABILITY_FORMATS),
    metrics: metricsSchema,
    runtime: runtimeSchema,
    audit: auditSchema,
    prometheus: z.string().optional(),
    source_is_untrusted: z.literal(true),
    secrets_redacted: z.literal(true),
  })
  .strict();

export const observabilityOutputSchema = createFeatureResultSchema(observabilityDataSchema);

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function escapePrometheusLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .slice(0, 120);
}

function metricToolLabel(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_:]/gu, "_").slice(0, 80);
  return normalized.length > 0 ? normalized : "unknown";
}

function prometheusExport(
  metrics: ReturnType<typeof getMetricsSnapshot>,
  runtime: z.infer<typeof runtimeSchema>,
  audit: ReturnType<typeof getAuditStatus>,
): string {
  const lines = [
    "# HELP src_mcp_process_uptime_ms Process uptime in milliseconds.",
    "# TYPE src_mcp_process_uptime_ms gauge",
    `src_mcp_process_uptime_ms ${String(runtime.uptime_ms)}`,
    "# HELP src_mcp_process_rss_bytes Resident set size in bytes.",
    "# TYPE src_mcp_process_rss_bytes gauge",
    `src_mcp_process_rss_bytes ${String(runtime.rss_bytes)}`,
    "# HELP src_mcp_process_heap_used_bytes V8 heap used in bytes.",
    "# TYPE src_mcp_process_heap_used_bytes gauge",
    `src_mcp_process_heap_used_bytes ${String(runtime.heap_used_bytes)}`,
    "# HELP src_mcp_process_heap_total_bytes V8 heap total in bytes.",
    "# TYPE src_mcp_process_heap_total_bytes gauge",
    `src_mcp_process_heap_total_bytes ${String(runtime.heap_total_bytes)}`,
    "# HELP src_mcp_audit_events_total Number of local audit events retained.",
    "# TYPE src_mcp_audit_events_total gauge",
    `src_mcp_audit_events_total ${String(audit.events)}`,
    "# HELP src_mcp_tool_calls_total Number of calls observed for a tool.",
    "# TYPE src_mcp_tool_calls_total counter",
    "# HELP src_mcp_tool_successes_total Number of successful tool calls.",
    "# TYPE src_mcp_tool_successes_total counter",
    "# HELP src_mcp_tool_failures_total Number of failed tool calls.",
    "# TYPE src_mcp_tool_failures_total counter",
    "# HELP src_mcp_tool_duration_ms_total Total observed tool duration.",
    "# TYPE src_mcp_tool_duration_ms_total counter",
    "# HELP src_mcp_tool_last_duration_ms Last observed tool duration.",
    "# TYPE src_mcp_tool_last_duration_ms gauge",
    "# HELP src_mcp_tool_duration_ms_p50 Recent p50 tool duration.",
    "# TYPE src_mcp_tool_duration_ms_p50 gauge",
    "# HELP src_mcp_tool_duration_ms_p95 Recent p95 tool duration.",
    "# TYPE src_mcp_tool_duration_ms_p95 gauge",
  ];
  for (const [tool, metric] of Object.entries(metrics.tools).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const labels = `tool="${escapePrometheusLabel(metricToolLabel(tool))}"`;
    lines.push(
      `src_mcp_tool_calls_total{${labels}} ${String(metric.calls)}`,
      `src_mcp_tool_successes_total{${labels}} ${String(metric.successes)}`,
      `src_mcp_tool_failures_total{${labels}} ${String(metric.failures)}`,
      `src_mcp_tool_duration_ms_total{${labels}} ${String(metric.totalDurationMs)}`,
      `src_mcp_tool_last_duration_ms{${labels}} ${String(metric.lastDurationMs)}`,
      `src_mcp_tool_duration_ms_p50{${labels}} ${String(metric.p50DurationMs)}`,
      `src_mcp_tool_duration_ms_p95{${labels}} ${String(metric.p95DurationMs)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function execute(rawInput: ObservabilityInput): FeatureResult {
  const input = observabilitySchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }

  const memory = process.memoryUsage();
  const runtime = {
    uptime_ms: nonNegativeInteger(process.uptime() * 1_000),
    rss_bytes: nonNegativeInteger(memory.rss),
    heap_used_bytes: nonNegativeInteger(memory.heapUsed),
    heap_total_bytes: nonNegativeInteger(memory.heapTotal),
  };
  const metrics = getMetricsSnapshot();
  const audit = getAuditStatus(secureDirectory.path);
  const prometheus =
    input.format === "prometheus" ? prometheusExport(metrics, runtime, audit) : undefined;
  const data = {
    directory: secureDirectory.path,
    format: input.format,
    metrics,
    runtime,
    audit,
    ...(prometheus === undefined ? {} : { prometheus }),
    source_is_untrusted: true as const,
    secrets_redacted: true as const,
  };
  return {
    success: true,
    message:
      prometheus ??
      `Local observability snapshot: ${String(Object.keys(metrics.tools).length)} tool(s) tracked`,
    data,
  };
}

export const observabilityFeature: Feature<typeof observabilitySchema> = {
  name: "get_observability",
  title: "Get local observability",
  description:
    "Read bounded local metrics, runtime counters, and secret-free audit status as structured JSON or a Prometheus text export; no telemetry leaves the process.",
  schema: observabilitySchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  outputSchema: observabilityOutputSchema,
  execute,
};
