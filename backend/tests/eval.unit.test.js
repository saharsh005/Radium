import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  recallAtK,
  precisionAtK,
  hitRateAtK,
  reciprocalRank,
  ndcgAtK,
  scoreRanking,
  mean,
  percentile,
  summarizeLatencies,
} from "../eval/metrics.js";

describe("retrieval metrics", () => {
  const ranked = ["a", "b", "c", "d"];
  const relevant = ["b", "d"];

  it("recall@K", () => {
    assert.equal(recallAtK(ranked, relevant, 1), 0);
    assert.equal(recallAtK(ranked, relevant, 2), 0.5);
    assert.equal(recallAtK(ranked, relevant, 4), 1);
  });

  it("precision@K", () => {
    assert.equal(precisionAtK(ranked, relevant, 2), 0.5);
    assert.equal(precisionAtK(ranked, relevant, 4), 0.5);
    assert.equal(precisionAtK([], relevant, 4), 0);
  });

  it("hitRate@K and reciprocalRank", () => {
    assert.equal(hitRateAtK(ranked, relevant, 1), 0);
    assert.equal(hitRateAtK(ranked, relevant, 2), 1);
    assert.equal(reciprocalRank(ranked, relevant), 0.5);
    assert.equal(reciprocalRank(["x", "y"], relevant), 0);
  });

  it("ndcg@K rewards early relevant hits", () => {
    const early = ndcgAtK(["b", "x", "y"], relevant, 3);
    const late = ndcgAtK(["x", "y", "b"], relevant, 3);
    assert.ok(early > late);
    assert.equal(ndcgAtK(ranked, relevant, 4) <= 1, true);
  });

  it("returns null without relevance labels", () => {
    assert.equal(recallAtK(ranked, [], 2), null);
    assert.equal(hitRateAtK(ranked, [], 2), null);
    assert.equal(ndcgAtK(ranked, [], 2), null);
  });

  it("scoreRanking bundles all metrics", () => {
    const s = scoreRanking(ranked, relevant, 2);
    assert.deepEqual(
      [s.recall, s.precision, s.hitRate, s.mrr],
      [0.5, 0.5, 1, 0.5]
    );
  });

  it("mean ignores non-numbers and nulls on empty", () => {
    assert.equal(mean([1, 0.5, null, 0.5]), 2 / 3);
    assert.equal(mean([]), null);
  });

  it("percentile uses nearest-rank", () => {
    assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
    assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
    assert.equal(percentile([7], 95), 7);
    assert.equal(percentile([], 50), null);
  });

  it("summarizeLatencies reports n/mean/p50/p95/min/max", () => {
    const s = summarizeLatencies([1, 2, 3, 4, 5]);
    assert.deepEqual([s.n, s.mean, s.p50, s.p95, s.min, s.max], [5, 3, 3, 5, 1, 5]);
    assert.equal(summarizeLatencies([]), null);
  });
});
