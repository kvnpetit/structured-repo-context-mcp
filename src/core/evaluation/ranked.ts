import { estimateTokenCount, type RetrievalMetrics } from "./retrieval";

export interface RetrievedDocument {
  id: string;
  text: string;
}

export interface RankedEvaluation {
  relevant: readonly string[];
  /** Actual returned chunks in engine order; no evaluation-time reranking. */
  retrieved: readonly RetrievedDocument[];
}

/** File-level relevance in the first k returned chunks, with duplicate files
 * counted once. Context cost includes every returned chunk, including duplicates.
 */
export function evaluateRankedRetrieval(
  evaluations: readonly RankedEvaluation[],
  k: number,
): RetrievalMetrics {
  if (!Number.isSafeInteger(k) || k < 1) {
    throw new Error("Evaluation cutoff must be a positive integer");
  }
  let precision = 0;
  let recall = 0;
  let mrr = 0;
  let ndcg = 0;
  let returnedBytes = 0;
  let returnedTokens = 0;
  for (const evaluation of evaluations) {
    const relevant = new Set(evaluation.relevant);
    const chunks = evaluation.retrieved.slice(0, k);
    const seen = new Set<string>();
    const gains = chunks.map(({ id }) => {
      const hit = relevant.has(id) && !seen.has(id);
      seen.add(id);
      return hit;
    });
    const hits = gains.filter(Boolean).length;
    precision += hits / k;
    recall += relevant.size === 0 ? 0 : hits / relevant.size;
    const firstRelevant = gains.findIndex(Boolean);
    mrr += firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1);
    const gain = gains.reduce(
      (total, hit, index) => total + (hit ? 1 / Math.log2(index + 2) : 0),
      0,
    );
    const idealGain = Array.from(
      { length: Math.min(k, relevant.size) },
      (_, index) => 1 / Math.log2(index + 2),
    ).reduce((total, value) => total + value, 0);
    ndcg += idealGain === 0 ? 0 : gain / idealGain;
    for (const chunk of chunks) {
      returnedBytes += Buffer.byteLength(chunk.text, "utf8");
      returnedTokens += estimateTokenCount(chunk.text);
    }
  }
  const mean = (value: number): number =>
    evaluations.length === 0
      ? 0
      : Number((value / evaluations.length).toFixed(4));
  return {
    queries: evaluations.length,
    evaluatedAtK: k,
    precisionAtK: mean(precision),
    recallAtK: mean(recall),
    mrr: mean(mrr),
    ndcgAtK: mean(ndcg),
    meanReturnedBytesAtK: mean(returnedBytes),
    meanEstimatedTokensAtK: mean(returnedTokens),
  };
}
