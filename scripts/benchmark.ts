import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { chunkFile } from "@core/embeddings/chunker";
import { createLexicalEmbeddingClient } from "@core/embeddings/client";
import type { CodeChunk } from "@core/embeddings/types";
import { collectFiles, createIgnoreFilter } from "@core/files";
import { readSecureTextFile, resolveSecureDirectory } from "@core/security";
import {
  estimateTokenCount,
  evaluateRetrieval,
  type RetrievalQuery,
} from "@core/evaluation";

interface BenchmarkOptions {
  directory: string;
  iterations: number;
  maxFiles: number;
  dataset?: string;
  evaluationK: number;
  minPrecisionAtK?: number;
  minRecallAtK?: number;
  minMrr?: number;
  minNdcgAtK?: number;
}

interface QualityGate {
  passed: boolean;
  thresholds: {
    precisionAtK?: number;
    recallAtK?: number;
    mrr?: number;
    ndcgAtK?: number;
  };
  failures: string[];
}

interface BenchmarkReport {
  directory: string;
  files: number;
  bytes: number;
  chunks: number;
  iterations: number;
  chunkingMs: { p50: number; p95: number; total: number };
  embeddingMs: { p50: number; p95: number; total: number };
  embeddingDimensions: number;
  tokenCost: {
    indexedTextTokens: number;
    embeddedInputTokens: number;
    embeddedChunkCount: number;
  };
  qualityGate?: QualityGate;
  rssMiB: number;
  notes: string[];
  retrieval?: ReturnType<typeof evaluateRetrieval> & { dataset: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function readThreshold(name: string): number | undefined {
  const raw = readOption(name);
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`--${name} must be a number between 0 and 1`);
  }
  return value;
}

function optionsFromArgs(): BenchmarkOptions {
  const directory = readOption("directory") ?? process.cwd();
  const iterations = Math.max(
    1,
    Number.parseInt(readOption("iterations") ?? "1", 10) || 1,
  );
  const maxFiles = Math.max(
    1,
    Number.parseInt(readOption("max-files") ?? "100", 10) || 100,
  );
  const evaluationK = Math.max(
    1,
    Number.parseInt(readOption("k") ?? "10", 10) || 10,
  );
  return {
    directory,
    iterations,
    maxFiles,
    dataset: readOption("dataset"),
    evaluationK,
    minPrecisionAtK: readThreshold("min-precision-at-k"),
    minRecallAtK: readThreshold("min-recall-at-k"),
    minMrr: readThreshold("min-mrr"),
    minNdcgAtK: readThreshold("min-ndcg-at-k"),
  };
}

function loadRetrievalDataset(datasetPath: string): RetrievalQuery[] {
  const size = fs.statSync(datasetPath).size;
  if (size > 1024 * 1024) {
    throw new Error("Benchmark dataset must not exceed 1 MiB");
  }
  const raw: unknown = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  if (!Array.isArray(raw) || raw.length > 1000) {
    throw new Error(
      "Benchmark dataset must be an array of at most 1000 queries",
    );
  }
  return raw.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.query !== "string" ||
      !Array.isArray(entry.relevant) ||
      entry.relevant.some((value: unknown) => typeof value !== "string")
    ) {
      throw new Error(`Invalid benchmark query at index ${String(index)}`);
    }
    return {
      query: entry.query,
      relevant: entry.relevant as string[],
    };
  });
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return Number((sorted[index] ?? 0).toFixed(2));
}

function qualityGateFor(
  metrics: ReturnType<typeof evaluateRetrieval>,
  options: BenchmarkOptions,
): QualityGate {
  const thresholds: QualityGate["thresholds"] = {
    ...(options.minPrecisionAtK === undefined
      ? {}
      : { precisionAtK: options.minPrecisionAtK }),
    ...(options.minRecallAtK === undefined
      ? {}
      : { recallAtK: options.minRecallAtK }),
    ...(options.minMrr === undefined ? {} : { mrr: options.minMrr }),
    ...(options.minNdcgAtK === undefined
      ? {}
      : { ndcgAtK: options.minNdcgAtK }),
  };
  const failures: string[] = [];
  const checks: [keyof QualityGate["thresholds"], number][] = [
    ["precisionAtK", metrics.precisionAtK],
    ["recallAtK", metrics.recallAtK],
    ["mrr", metrics.mrr],
    ["ndcgAtK", metrics.ndcgAtK],
  ];
  for (const [metric, actual] of checks) {
    const threshold = thresholds[metric];
    if (threshold !== undefined && actual < threshold) {
      failures.push(
        `${metric}=${String(actual)} is below ${String(threshold)}`,
      );
    }
  }
  return { passed: failures.length === 0, thresholds, failures };
}

async function runBenchmark(
  options: BenchmarkOptions,
): Promise<BenchmarkReport> {
  const secureDirectory = resolveSecureDirectory(options.directory);
  if (!secureDirectory.ok) {
    throw new Error(secureDirectory.error);
  }

  const directory = secureDirectory.path;
  const ignore = createIgnoreFilter(directory);
  const files = collectFiles(directory, ignore, directory).slice(
    0,
    options.maxFiles,
  );
  const payloads = files.flatMap((filePath) => {
    const result = readSecureTextFile(filePath, directory);
    return result.ok && result.content !== undefined
      ? [
          {
            filePath,
            content: result.content,
            id: path.relative(directory, filePath).replaceAll(path.sep, "/"),
          },
        ]
      : [];
  });
  if (payloads.length === 0) {
    throw new Error("No indexable files were found");
  }

  const embeddingClient = createLexicalEmbeddingClient(768);
  const chunkingTimes: number[] = [];
  const embeddingTimes: number[] = [];
  let totalChunks = 0;
  let totalBytes = 0;
  let embeddedInputTokens = 0;
  let embeddedChunkCount = 0;

  for (const payload of payloads) {
    totalBytes += Buffer.byteLength(payload.content, "utf8");
  }

  for (let iteration = 0; iteration < options.iterations; iteration++) {
    const chunks: CodeChunk[] = [];
    const chunkStart = performance.now();
    for (const payload of payloads) {
      chunks.push(
        ...(await chunkFile(payload.filePath, payload.content, {
          defaultChunkSize: 1000,
          defaultChunkOverlap: 200,
        })),
      );
    }
    chunkingTimes.push(performance.now() - chunkStart);
    totalChunks = chunks.length;

    const embeddingStart = performance.now();
    const embeddedChunks = chunks.slice(0, 500);
    embeddedChunkCount = embeddedChunks.length;
    embeddedInputTokens = embeddedChunks.reduce(
      (total, chunk) => total + estimateTokenCount(chunk.content),
      0,
    );
    await embeddingClient.embedBatch(
      embeddedChunks.map((chunk) => chunk.content),
    );
    embeddingTimes.push(performance.now() - embeddingStart);
  }

  const report: BenchmarkReport = {
    directory: path.resolve(directory),
    files: payloads.length,
    bytes: totalBytes,
    chunks: totalChunks,
    iterations: options.iterations,
    chunkingMs: {
      p50: percentile(chunkingTimes, 0.5),
      p95: percentile(chunkingTimes, 0.95),
      total: Number(
        chunkingTimes.reduce((sum, value) => sum + value, 0).toFixed(2),
      ),
    },
    embeddingMs: {
      p50: percentile(embeddingTimes, 0.5),
      p95: percentile(embeddingTimes, 0.95),
      total: Number(
        embeddingTimes.reduce((sum, value) => sum + value, 0).toFixed(2),
      ),
    },
    embeddingDimensions: 768,
    tokenCost: {
      indexedTextTokens: payloads.reduce(
        (total, payload) => total + estimateTokenCount(payload.content),
        0,
      ),
      embeddedInputTokens,
      embeddedChunkCount,
    },
    rssMiB: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
    notes: [
      "The benchmark uses the deterministic lexical provider for reproducible local measurements.",
      options.dataset === undefined
        ? "Pass --dataset=benchmarks/retrieval.json --k=5 to compute precision@k, recall@k, MRR, nDCG, and estimated returned-token cost on a labelled corpus. Add --min-recall-at-k, --min-mrr, or --min-ndcg-at-k to enforce quality gates."
        : "Retrieval metrics are a deterministic file-level baseline; compare them with the same dataset when changing ranking or embedding configuration.",
    ],
  };
  if (options.dataset !== undefined) {
    const datasetPath = path.resolve(options.dataset);
    const queries = loadRetrievalDataset(datasetPath);
    report.retrieval = {
      dataset: datasetPath,
      ...evaluateRetrieval(
        payloads.map((payload) => ({
          id: payload.id,
          text: `${payload.id}\n${payload.content}`,
        })),
        queries,
        options.evaluationK,
      ),
    };
    report.qualityGate = qualityGateFor(report.retrieval, options);
  }
  return report;
}

runBenchmark(optionsFromArgs())
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
    if (report.qualityGate !== undefined && !report.qualityGate.passed) {
      process.exitCode = 2;
    }
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
