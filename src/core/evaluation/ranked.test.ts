import { describe, expect, test } from "vitest";

import { evaluateRankedRetrieval } from "./ranked";

describe("evaluation of actual engine rankings", () => {
  test("uses returned order even when an unrelated result contains the query", () => {
    const evaluation = {
      relevant: ["target.ts"],
      retrieved: [
        { id: "other.ts", text: "target target target" },
        { id: "target.ts", text: "result" },
      ],
    };
    expect(evaluateRankedRetrieval([evaluation], 1)).toMatchObject({
      precisionAtK: 0,
      recallAtK: 0,
      mrr: 0,
    });
    expect(evaluateRankedRetrieval([evaluation], 2)).toMatchObject({
      precisionAtK: 0.5,
      recallAtK: 1,
      mrr: 0.5,
      ndcgAtK: 0.6309,
    });
  });

  test("counts duplicate files once but includes their actual context cost", () => {
    expect(
      evaluateRankedRetrieval(
        [
          {
            relevant: ["same.ts", "same.ts", "missing.ts"],
            retrieved: [
              { id: "same.ts", text: "abcd" },
              { id: "same.ts", text: "éé" },
            ],
          },
        ],
        2,
      ),
    ).toMatchObject({
      queries: 1,
      precisionAtK: 0.5,
      recallAtK: 0.5,
      mrr: 1,
      meanReturnedBytesAtK: 8,
      meanEstimatedTokensAtK: 2,
    });
  });

  test("handles empty results and rejects invalid cutoffs", () => {
    expect(
      evaluateRankedRetrieval([{ relevant: ["missing"], retrieved: [] }], 5),
    ).toMatchObject({ precisionAtK: 0, recallAtK: 0, mrr: 0, ndcgAtK: 0 });
    expect(evaluateRankedRetrieval([], 5).queries).toBe(0);
    expect(() => evaluateRankedRetrieval([], 0)).toThrow("positive integer");
    expect(() => evaluateRankedRetrieval([], 1.5)).toThrow("positive integer");
  });

  test("duplicate chunks consume their original ranking positions", () => {
    const metrics = evaluateRankedRetrieval(
      [
        {
          relevant: ["hit"],
          retrieved: [
            { id: "miss", text: "a" },
            { id: "miss", text: "b" },
            { id: "hit", text: "c" },
          ],
        },
      ],
      3,
    );
    expect(metrics).toMatchObject({
      precisionAtK: 0.3333,
      recallAtK: 1,
      mrr: 0.3333,
      ndcgAtK: 0.5,
      meanReturnedBytesAtK: 3,
    });
  });
});
