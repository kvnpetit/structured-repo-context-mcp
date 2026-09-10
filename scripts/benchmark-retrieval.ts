import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import type { SearchMode } from "@core/embeddings";
import type { RetrievalQuery } from "@core/evaluation";
import type { SearchOutput } from "@features/search-code/types";
import type { RankedEvaluation } from "@core/evaluation/ranked";

function option(name: string): string | undefined {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function integer(name: string, fallback: number, maximum: number): number {
  const value = Number(option(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`--${name} must be an integer between 1 and ${String(maximum)}`);
  }
  return value;
}

function threshold(name: string): number | undefined {
  const raw = option(name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (raw.trim().length === 0 || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`--${name} must be between 0 and 1`);
  }
  return value;
}

function percentile(values: readonly number[], ratio: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return Number((ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)] ?? 0).toFixed(2));
}

function removeScratch(scratch: string): void {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(scratch));
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !path.basename(scratch).startsWith("src-retrieval-engine-")
  ) {
    throw new Error("Refusing cleanup outside the benchmark temporary directory");
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

function dataset(filePath: string): RetrievalQuery[] {
  if (fs.statSync(filePath).size > 1024 * 1024) {
    throw new Error("Dataset exceeds 1 MiB");
  }
  const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 1000) {
    throw new Error("Dataset must contain between 2 and 1000 labelled queries");
  }
  return raw.map((item: unknown) => {
    if (item === null || typeof item !== "object") {
      throw new Error("Invalid retrieval label");
    }
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.query !== "string" ||
      entry.query.trim().length === 0 ||
      entry.query.length > 4000 ||
      !Array.isArray(entry.relevant) ||
      entry.relevant.length === 0 ||
      entry.relevant.some((id: unknown) => typeof id !== "string")
    ) {
      throw new Error("Every label requires a query and at least one relevant file ID");
    }
    return { query: entry.query, relevant: entry.relevant as string[] };
  });
}

async function run(): Promise<void> {
  const directory = path.resolve(option("directory") ?? "benchmarks/golden-multilang");
  const datasetPath = path.resolve(option("dataset") ?? "benchmarks/retrieval-engine.json");
  const iterations = integer("iterations", 5, 100);
  const warmup = integer("warmup", 1, 10);
  const maxFiles = integer("max-files", 500, 5000);
  const k = integer("k", 5, 100);
  const provider = option("provider") ?? "lexical";
  if (provider !== "lexical" && provider !== "ollama") {
    throw new Error("--provider must be lexical or ollama (already installed locally)");
  }
  const modes = [...new Set((option("modes") ?? "fts,hybrid,vector").split(","))];
  if (modes.length === 0 || modes.some((mode) => !["fts", "hybrid", "vector"].includes(mode))) {
    throw new Error("--modes accepts fts,hybrid,vector");
  }
  const rerank = option("rerank") ?? "lexical";
  if (rerank !== "none" && rerank !== "lexical" && rerank !== "code") {
    throw new Error("--rerank must be none, lexical or code");
  }
  const thresholds = {
    precisionAtK: threshold("min-precision-at-k"),
    recallAtK: threshold("min-recall-at-k"),
    mrr: threshold("min-mrr"),
    ndcgAtK: threshold("min-ndcg-at-k"),
  };

  // Configure before importing the application: its config is captured at load.
  process.env.EMBEDDING_PROVIDER = provider;
  process.env.LOG_LEVEL = "warn";
  const { collectFiles, createIgnoreFilter } = await import("@core/files");
  const { readSecureTextFile, resolveSecureDirectory, isPathWithin } = await import(
    "@core/security"
  );
  const { evaluateRankedRetrieval } = await import("@core/evaluation/ranked");
  const { EMBEDDING_CONFIG } = await import("@config");
  const { execute: indexCodebase, indexCodebaseSchema } = await import("@features/index-codebase");
  const { execute: searchCode } = await import("@features/search-code");

  const source = resolveSecureDirectory(directory);
  if (!source.ok) {
    throw new Error(source.error);
  }
  const queries = dataset(datasetPath);
  const files = collectFiles(source.path, createIgnoreFilter(source.path), source.path).sort();
  const selected = files.slice(0, maxFiles);
  const selectedIds = new Set(
    selected.map((filePath) => path.relative(source.path, filePath).replaceAll(path.sep, "/")),
  );
  for (const query of queries) {
    for (const id of query.relevant) {
      if (!selectedIds.has(id)) {
        throw new Error(
          `Relevant file ${id} is absent from the selected corpus; fix labels or increase --max-files`,
        );
      }
    }
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "src-retrieval-engine-"));
  const originalRoots = process.env.SRC_ALLOWED_ROOTS;
  const initialRss = process.memoryUsage().rss;
  let peakRss = initialRss;
  const sampleMemory = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 25);
  let copiedBytes = 0;
  try {
    for (const filePath of selected) {
      const read = readSecureTextFile(filePath, source.path);
      if (!read.ok || read.content === undefined) {
        throw new Error(`Cannot safely copy corpus file ${path.relative(source.path, filePath)}`);
      }
      copiedBytes += Buffer.byteLength(read.content, "utf8");
      if (copiedBytes > 256 * 1024 * 1024) {
        throw new Error("Selected corpus exceeds the 256 MiB benchmark bound");
      }
      const target = path.resolve(scratch, path.relative(source.path, filePath));
      if (!isPathWithin(scratch, target)) {
        throw new Error("Corpus destination escaped its temporary root");
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, read.content);
    }
    process.env.SRC_ALLOWED_ROOTS = scratch;
    const indexStart = performance.now();
    const indexed = await indexCodebase(indexCodebaseSchema.parse({ directory: scratch }));
    const indexingMs = Number((performance.now() - indexStart).toFixed(2));
    if (!indexed.success) {
      throw new Error(indexed.error ?? "Indexing failed");
    }
    const indexData = indexed.data as {
      filesIndexed: number;
      chunksCreated: number;
      errors: string[];
    };
    if (indexData.errors.length > 0 || indexData.filesIndexed !== selected.length) {
      throw new Error("Indexing did not cover the complete selected corpus");
    }

    const failures: string[] = [];
    const reports = [];
    for (const mode of modes as SearchMode[]) {
      const latencies: number[] = [];
      const evaluations: RankedEvaluation[] = [];
      const queryReports = [];
      for (const query of queries) {
        let first: SearchOutput | undefined;
        let firstIdentity: string | undefined;
        let stable = true;
        let bounded = false;
        const timings: number[] = [];
        for (let iteration = -warmup; iteration < iterations; iteration++) {
          const start = performance.now();
          const response = await searchCode({
            directory: scratch,
            query: query.query,
            mode,
            limit: k,
            rerank,
            includeCallContext: false,
          });
          const elapsed = performance.now() - start;
          if (!response.success) {
            throw new Error(`${mode} search failed: ${response.error ?? "unknown failure"}`);
          }
          if (iteration < 0) {
            continue;
          }
          const data = response.data as SearchOutput;
          first ??= data;
          const identity = JSON.stringify(
            data.results.map((result) => [
              result.filePath,
              result.startLine,
              result.endLine,
              result.score,
            ]),
          );
          firstIdentity ??= identity;
          stable &&= identity === firstIdentity;
          bounded ||= data.truncated;
          timings.push(elapsed);
          latencies.push(elapsed);
        }
        if (first === undefined) {
          throw new Error("No measured query result");
        }
        const evaluation = {
          relevant: query.relevant,
          retrieved: first.results.map((result) => ({
            id: result.filePath,
            text: result.content,
          })),
        };
        evaluations.push(evaluation);
        queryReports.push({
          query: query.query,
          relevant: query.relevant,
          returned: [...new Set(first.results.map((result) => result.filePath))],
          returnedChunks: first.resultsCount,
          latencyMs: {
            p50: percentile(timings, 0.5),
            p95: percentile(timings, 0.95),
          },
          rankingStable: stable,
          moreResultsOrCandidateBound: bounded,
          quality: evaluateRankedRetrieval([evaluation], k),
        });
      }
      const quality = evaluateRankedRetrieval(evaluations, k);
      for (const [metric, minimum] of Object.entries(thresholds)) {
        const actual = quality[metric as keyof typeof thresholds];
        if (minimum !== undefined && actual < minimum) {
          failures.push(`${mode}.${metric}=${String(actual)} is below ${String(minimum)}`);
        }
      }
      if (queryReports.some((query) => !query.rankingStable)) {
        failures.push(`${mode} returned unstable rankings for an unchanged index`);
      }
      reports.push({
        mode,
        quality,
        samples: latencies.length,
        latencyMs: {
          p50: percentile(latencies, 0.5),
          p95: percentile(latencies, 0.95),
        },
        queries: queryReports,
      });
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    console.log(
      JSON.stringify(
        {
          benchmark: "native-index-and-search",
          directory: source.path,
          dataset: datasetPath,
          provider,
          model: EMBEDDING_CONFIG.embeddingModel,
          dimensions: EMBEDDING_CONFIG.embeddingDimensions,
          files: selected.length,
          filesTruncated: files.length > selected.length,
          bytes: copiedBytes,
          chunks: indexData.chunksCreated,
          indexingMs,
          iterations,
          warmupIterations: warmup,
          k,
          rerank,
          rssMiB: {
            start: Number((initialRss / 1024 / 1024).toFixed(2)),
            sampledPeak: Number((peakRss / 1024 / 1024).toFixed(2)),
          },
          qualityGate: { passed: failures.length === 0, thresholds, failures },
          modes: reports,
          notes: [
            "Uses index_codebase and search_code with native LanceDB in a disposable copy; the source repository and its index are unchanged.",
            "Latency includes feature execution, store connection, query embedding, retrieval, reranking and formatting; excludes MCP transport and optional call-context construction.",
            "Relevance is measured on unique file IDs in the first k returned chunks, without evaluation-time reranking. Precision divides by k; cost includes duplicate-file chunks.",
            "RSS is sampled every 25 ms; token cost estimates UTF-8 bytes / 4. Neither is an exact peak or tokenizer billing measurement.",
            provider === "lexical"
              ? "Lexical vectors are deterministic local token hashes; this measures the zero-service configuration, not neural semantic retrieval quality."
              : "Ollama must already be available locally; this benchmark never downloads a model.",
            "The bundled corpus is a small regression fixture. General quality claims require labels representative of the user's repository and queries.",
          ],
        },
        null,
        2,
      ),
    );
    if (failures.length > 0) {
      process.exitCode = 2;
    }
  } finally {
    clearInterval(sampleMemory);
    if (originalRoots === undefined) {
      delete process.env.SRC_ALLOWED_ROOTS;
    } else {
      process.env.SRC_ALLOWED_ROOTS = originalRoots;
    }
    removeScratch(scratch);
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
