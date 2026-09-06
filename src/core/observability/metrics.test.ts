import { describe, expect, test } from "vitest";

import { MetricsRegistry } from "@core/observability";

describe("bounded metrics registry", () => {
  test("records success/failure counts and latency percentiles", () => {
    const registry = new MetricsRegistry();
    registry.recordTool("search_code", true, 10.234);
    registry.recordTool("search_code", false, 20.678);

    expect(registry.snapshot().tools.search_code).toMatchObject({
      calls: 2,
      successes: 1,
      failures: 1,
      totalDurationMs: 30.91,
      p50DurationMs: 10.23,
      p95DurationMs: 20.68,
    });
  });

  test("keeps latency samples bounded and can reset counters", () => {
    const registry = new MetricsRegistry();
    for (let index = 0; index < 250; index += 1) {
      registry.recordTool("index_codebase", true, index);
    }

    const metric = registry.snapshot().tools.index_codebase;
    expect(metric?.calls).toBe(250);
    expect(metric?.p95DurationMs).toBeGreaterThan(0);

    registry.reset();
    expect(registry.snapshot().tools).toEqual({});
  });

  test("bounds tool cardinality and normalizes names", () => {
    const registry = new MetricsRegistry();
    registry.recordTool("  search_code  ", true, 1);
    expect(registry.snapshot().tools.search_code?.calls).toBe(1);

    for (let index = 0; index < 300; index += 1) {
      registry.recordTool(`tool-${String(index)}`, true, 1);
    }

    expect(Object.keys(registry.snapshot().tools).length).toBeLessThanOrEqual(
      256,
    );
  });
});
