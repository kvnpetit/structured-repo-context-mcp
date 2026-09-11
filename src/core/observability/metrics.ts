const MAX_LATENCY_SAMPLES = 200;
const MAX_TRACKED_TOOLS = 256;

interface MutableToolMetric {
  calls: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
  lastDurationMs: number;
  latencies: number[];
}

export interface ToolMetricSnapshot {
  calls: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
  lastDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
}

export interface MetricsSnapshot {
  startedAt: string;
  tools: Record<string, ToolMetricSnapshot>;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

/** Bounded in-process metrics; it never stores request arguments or source text. */
export class MetricsRegistry {
  readonly startedAt = new Date().toISOString();
  private readonly tools = new Map<string, MutableToolMetric>();

  recordTool(toolName: string, success: boolean, durationMs: number): void {
    const boundedToolName = toolName.trim().slice(0, 100);
    if (boundedToolName.length === 0) {
      return;
    }
    if (!this.tools.has(boundedToolName) && this.tools.size >= MAX_TRACKED_TOOLS) {
      return;
    }
    const metric = this.tools.get(boundedToolName) ?? {
      calls: 0,
      successes: 0,
      failures: 0,
      totalDurationMs: 0,
      lastDurationMs: 0,
      latencies: [],
    };
    const boundedDuration = Number.isFinite(durationMs)
      ? Math.max(0, Math.round(durationMs * 100) / 100)
      : 0;
    metric.calls += 1;
    if (success) {
      metric.successes += 1;
    } else {
      metric.failures += 1;
    }
    metric.totalDurationMs += boundedDuration;
    metric.lastDurationMs = boundedDuration;
    metric.latencies.push(boundedDuration);
    if (metric.latencies.length > MAX_LATENCY_SAMPLES) {
      metric.latencies.shift();
    }
    this.tools.set(boundedToolName, metric);
  }

  snapshot(): MetricsSnapshot {
    const tools: Record<string, ToolMetricSnapshot> = {};
    for (const [name, metric] of this.tools) {
      tools[name] = {
        calls: metric.calls,
        successes: metric.successes,
        failures: metric.failures,
        totalDurationMs: Math.round(metric.totalDurationMs * 100) / 100,
        lastDurationMs: metric.lastDurationMs,
        p50DurationMs: percentile(metric.latencies, 0.5),
        p95DurationMs: percentile(metric.latencies, 0.95),
      };
    }
    return { startedAt: this.startedAt, tools };
  }

  reset(): void {
    this.tools.clear();
  }
}

export const metrics = new MetricsRegistry();

export function getMetricsSnapshot(): MetricsSnapshot {
  return metrics.snapshot();
}
