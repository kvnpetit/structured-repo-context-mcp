import { z } from "zod";

import { EMBEDDING_CONFIG } from "@config";
import {
  createLexicalEmbeddingClient,
  createOllamaClient,
  type EmbeddingClient,
} from "@core/embeddings";
import {
  getConfiguredAllowedRoots,
  getMaxFileBytes,
  hasConfiguredAllowedRoots,
  resolveSecureDirectory,
} from "@core/security";
import { getIndexStatusFeature } from "@features/get-index-status";
import { indexStatusDataSchema } from "@features/get-index-status";
import type { Feature, FeatureResult } from "@features/types";
import { createFeatureResultSchema } from "@features/utils";
import { getMetricsSnapshot } from "@core/observability";
import { getAuditStatus } from "@core/observability";
import { getTaskRuntimeConfig, TASKS_EXTENSION_ID } from "@core/tasks";
import { getMaxResultBytes } from "@config";

export const diagnosticsSchema = z.object({
  directory: z
    .string()
    .optional()
    .default(".")
    .describe("Project directory to diagnose"),
});

export type DiagnosticsInput = z.infer<typeof diagnosticsSchema>;

interface DiagnosticsOutput {
  directory: string;
  provider: {
    name: "ollama" | "lexical";
    model: string;
    dimensions: number;
    healthy: boolean;
    error?: string;
  };
  index: unknown;
  security: {
    allowedRootsConfigured: boolean;
    configuredRootCount: number;
    invalidConfiguredRoots: number;
    maxFileBytes: number;
    maxResultBytes: number;
    sourceExecution: "disabled";
  };
  tasks: {
    enabled: boolean;
    extension: typeof TASKS_EXTENSION_ID;
    configuredTools: string[];
    ttlMs: number | null;
    maxActiveTasks: number;
    storeConfigured: boolean;
  };
  metrics: ReturnType<typeof getMetricsSnapshot>;
  audit: ReturnType<typeof getAuditStatus>;
}

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

const diagnosticsDataSchema = z
  .object({
    directory: z.string(),
    provider: z
      .object({
        name: z.enum(["ollama", "lexical"]),
        model: z.string(),
        dimensions: z.number().int().positive(),
        healthy: z.boolean(),
        error: z.string().optional(),
      })
      .strict(),
    index: z.union([
      indexStatusDataSchema,
      z
        .object({ available: z.literal(false), error: z.string().optional() })
        .strict(),
    ]),
    security: z
      .object({
        allowedRootsConfigured: z.boolean(),
        configuredRootCount: z.number().int().nonnegative(),
        invalidConfiguredRoots: z.number().int().nonnegative(),
        maxFileBytes: z.number().int().positive(),
        maxResultBytes: z.number().int().positive(),
        sourceExecution: z.literal("disabled"),
      })
      .strict(),
    tasks: z
      .object({
        enabled: z.boolean(),
        extension: z.string(),
        configuredTools: z.string().array(),
        ttlMs: z.number().int().positive().nullable(),
        maxActiveTasks: z.number().int().positive(),
        storeConfigured: z.boolean(),
      })
      .strict(),
    metrics: z
      .object({
        startedAt: z.string(),
        tools: z.record(z.string(), metricSchema),
      })
      .strict(),
    audit: z
      .object({
        enabled: z.boolean(),
        file: z.string(),
        events: z.number().int().nonnegative(),
        last_event_at: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export const diagnosticsOutputSchema = createFeatureResultSchema(
  diagnosticsDataSchema,
);

export async function execute(input: DiagnosticsInput): Promise<FeatureResult> {
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }

  const embeddingClient: EmbeddingClient =
    EMBEDDING_CONFIG.embeddingProvider === "lexical"
      ? createLexicalEmbeddingClient(EMBEDDING_CONFIG.embeddingDimensions)
      : createOllamaClient(EMBEDDING_CONFIG);
  const health = await embeddingClient.healthCheck();
  const indexResult = await getIndexStatusFeature.execute({
    directory: secureDirectory.path,
  });
  const taskRuntime = getTaskRuntimeConfig();
  const configuredRoots = getConfiguredAllowedRoots();

  const output: DiagnosticsOutput = {
    directory: secureDirectory.path,
    provider: {
      name: EMBEDDING_CONFIG.embeddingProvider ?? "ollama",
      model: EMBEDDING_CONFIG.embeddingModel,
      dimensions: EMBEDDING_CONFIG.embeddingDimensions,
      healthy: health.ok,
      ...(health.error === undefined ? {} : { error: health.error }),
    },
    index: indexResult.success
      ? indexResult.data
      : { available: false, error: indexResult.error },
    security: {
      allowedRootsConfigured: hasConfiguredAllowedRoots(),
      configuredRootCount: configuredRoots.length,
      invalidConfiguredRoots:
        configuredRoots.filter((root) => !root.exists).length +
        (hasConfiguredAllowedRoots() && configuredRoots.length === 0 ? 1 : 0),
      maxFileBytes: getMaxFileBytes(),
      maxResultBytes: getMaxResultBytes(),
      sourceExecution: "disabled",
    },
    tasks: {
      enabled: taskRuntime.enabled,
      extension: TASKS_EXTENSION_ID,
      configuredTools: taskRuntime.toolNames,
      ttlMs: taskRuntime.ttlMs,
      maxActiveTasks: taskRuntime.maxActiveTasks,
      storeConfigured: Boolean(process.env.MCP_TASK_STORE_DIR?.trim()),
    },
    metrics: getMetricsSnapshot(),
    audit: getAuditStatus(secureDirectory.path),
  };

  const indexReady =
    indexResult.success &&
    typeof indexResult.data === "object" &&
    indexResult.data !== null &&
    "exists" in indexResult.data &&
    indexResult.data.exists === true;
  const message = [
    `Provider: ${output.provider.name} (${health.ok ? "healthy" : "unavailable"})`,
    `Index: ${indexReady ? "available" : "not ready"}`,
    `Security: ${String(output.security.maxFileBytes)}-byte file cap; ${String(output.security.maxResultBytes)}-byte result cap; source execution disabled`,
    `Tasks: ${output.tasks.enabled ? "enabled" : "disabled"}; metrics: ${String(Object.keys(output.metrics.tools).length)} tool(s) tracked`,
  ].join("\n");

  return { success: true, message, data: output };
}

export const diagnosticsFeature: Feature<typeof diagnosticsSchema> = {
  name: "get_diagnostics",
  title: "Get server diagnostics",
  description:
    "Inspect embedding provider health, index compatibility, path-security configuration, and resource limits without modifying the project.",
  schema: diagnosticsSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  outputSchema: diagnosticsOutputSchema,
  execute,
};
