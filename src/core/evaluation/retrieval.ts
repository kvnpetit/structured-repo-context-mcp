export interface RetrievalDocument {
  id: string;
  text: string;
}

export interface RetrievalQuery {
  query: string;
  relevant: string[];
}

export interface RetrievalMetrics {
  queries: number;
  evaluatedAtK: number;
  precisionAtK: number;
  recallAtK: number;
  mrr: number;
  ndcgAtK: number;
  meanReturnedBytesAtK: number;
  meanEstimatedTokensAtK: number;
}

/** A deliberately conservative, provider-independent token estimate. */
export function estimateTokenCount(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 4);
}

function queryTerms(query: string): string[] {
  return (
    query
      .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9_$]+/gu)
      ?.filter((term, index, terms) => terms.indexOf(term) === index) ?? []
  );
}

function occurrences(text: string, term: string): number {
  let count = 0;
  let offset = 0;
  while (offset < text.length) {
    const found = text.indexOf(term, offset);
    if (found < 0) {
      break;
    }
    count += 1;
    offset = found + Math.max(term.length, 1);
  }
  return count;
}

/** Deterministic, provider-independent baseline ranking for labelled corpora. */
export function rankDocuments(documents: readonly RetrievalDocument[], query: string): string[] {
  const normalizedQuery = query.toLowerCase();
  const terms = queryTerms(query);
  return documents
    .map((document) => {
      const id = document.id.toLowerCase();
      const text = document.text.toLowerCase();
      let score = text.includes(normalizedQuery) ? 5 : 0;
      for (const term of terms) {
        score += occurrences(text, term);
        score += occurrences(id, term) * 3;
      }
      return { id: document.id, score };
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .map((document) => document.id);
}

export function evaluateRetrieval(
  documents: readonly RetrievalDocument[],
  queries: readonly RetrievalQuery[],
  k = 10,
): RetrievalMetrics {
  const evaluatedAtK = Math.max(1, Math.floor(k));
  if (queries.length === 0) {
    return {
      queries: 0,
      evaluatedAtK,
      precisionAtK: 0,
      recallAtK: 0,
      mrr: 0,
      ndcgAtK: 0,
      meanReturnedBytesAtK: 0,
      meanEstimatedTokensAtK: 0,
    };
  }

  let precision = 0;
  let recall = 0;
  let reciprocalRank = 0;
  let ndcg = 0;
  let returnedBytes = 0;
  let estimatedTokens = 0;
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  for (const evaluation of queries) {
    const ranked = rankDocuments(documents, evaluation.query).slice(0, evaluatedAtK);
    const relevant = new Set(evaluation.relevant);
    const hits = ranked.filter((id) => relevant.has(id)).length;
    precision += hits / evaluatedAtK;
    recall += relevant.size === 0 ? 0 : hits / relevant.size;
    const firstRelevant = ranked.findIndex((id) => relevant.has(id));
    reciprocalRank += firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1);

    const discountedGain = ranked.reduce((total, id, index) => {
      if (!relevant.has(id)) {
        return total;
      }
      return total + 1 / Math.log2(index + 2);
    }, 0);
    const idealGain = Array.from(relevant, () => 1)
      .slice(0, evaluatedAtK)
      .reduce((total, _, index) => total + 1 / Math.log2(index + 2), 0);
    ndcg += idealGain === 0 ? 0 : discountedGain / idealGain;

    for (const id of ranked) {
      const document = documentsById.get(id);
      if (document === undefined) {
        continue;
      }
      const bytes = Buffer.byteLength(document.text, "utf8");
      returnedBytes += bytes;
      estimatedTokens += estimateTokenCount(document.text);
    }
  }

  return {
    queries: queries.length,
    evaluatedAtK,
    precisionAtK: round(precision / queries.length),
    recallAtK: round(recall / queries.length),
    mrr: round(reciprocalRank / queries.length),
    ndcgAtK: round(ndcg / queries.length),
    meanReturnedBytesAtK: round(returnedBytes / queries.length),
    meanEstimatedTokensAtK: round(estimatedTokens / queries.length),
  };
}

function round(value: number): number {
  return Number(value.toFixed(4));
}
