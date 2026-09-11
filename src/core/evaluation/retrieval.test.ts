import { describe, expect, test } from "vitest";

import { evaluateRetrieval, rankDocuments } from "@core/evaluation";

describe("retrieval evaluation", () => {
  const documents = [
    { id: "src/auth.ts", text: "authenticate user and validate token" },
    { id: "src/search.ts", text: "hybrid search combines BM25 and vectors" },
    { id: "README.md", text: "project documentation" },
  ];

  test("ranks exact identifiers and phrases deterministically", () => {
    expect(rankDocuments(documents, "hybrid search")[0]).toBe("src/search.ts");
    expect(rankDocuments(documents, "authenticateUser")[0]).toBe("src/auth.ts");
  });

  test("computes precision, recall and MRR at a declared cutoff", () => {
    expect(
      evaluateRetrieval(
        documents,
        [
          { query: "hybrid search", relevant: ["src/search.ts"] },
          { query: "authenticate", relevant: ["src/auth.ts"] },
        ],
        1,
      ),
    ).toEqual({
      queries: 2,
      evaluatedAtK: 1,
      precisionAtK: 1,
      recallAtK: 1,
      mrr: 1,
      ndcgAtK: 1,
      meanReturnedBytesAtK: 37.5,
      meanEstimatedTokensAtK: 9.5,
    });
  });

  test("returns zero metrics for an empty corpus", () => {
    expect(evaluateRetrieval(documents, [], 5)).toEqual({
      queries: 0,
      evaluatedAtK: 5,
      precisionAtK: 0,
      recallAtK: 0,
      mrr: 0,
      ndcgAtK: 0,
      meanReturnedBytesAtK: 0,
      meanEstimatedTokensAtK: 0,
    });
  });

  test("penalizes relevant documents that appear lower in the ranking", () => {
    const metrics = evaluateRetrieval(
      [
        { id: "target.ts", text: "unrelated" },
        { id: "second", text: "needle" },
      ],
      [{ query: "target", relevant: ["second"] }],
      2,
    );

    expect(metrics.ndcgAtK).toBeGreaterThan(0);
    expect(metrics.ndcgAtK).toBeLessThan(1);
  });
});
