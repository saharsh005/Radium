/**
 * Retrieval metrics (binary relevance).
 * All functions are pure; rankedIds[0] is rank 1.
 */

function topK(rankedIds, k) {
  return (rankedIds || []).slice(0, Math.max(0, k));
}

export function recallAtK(rankedIds, relevantIds, k) {
  const rel = new Set(relevantIds || []);
  if (rel.size === 0) return null; // undefined — no relevance labels
  const hits = topK(rankedIds, k).filter((id) => rel.has(id)).length;
  return hits / rel.size;
}

export function precisionAtK(rankedIds, relevantIds, k) {
  const rel = new Set(relevantIds || []);
  const top = topK(rankedIds, k);
  if (top.length === 0) return 0;
  return top.filter((id) => rel.has(id)).length / top.length;
}

export function hitRateAtK(rankedIds, relevantIds, k) {
  const rel = new Set(relevantIds || []);
  if (rel.size === 0) return null;
  return topK(rankedIds, k).some((id) => rel.has(id)) ? 1 : 0;
}

export function reciprocalRank(rankedIds, relevantIds) {
  const rel = new Set(relevantIds || []);
  const ranked = rankedIds || [];
  for (let i = 0; i < ranked.length; i++) {
    if (rel.has(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

export function ndcgAtK(rankedIds, relevantIds, k) {
  const rel = new Set(relevantIds || []);
  if (rel.size === 0) return null;
  const top = topK(rankedIds, k);
  let dcg = 0;
  top.forEach((id, i) => {
    if (rel.has(id)) dcg += 1 / Math.log2(i + 2);
  });
  const ideal = Math.min(rel.size, top.length);
  let idcg = 0;
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

// Convenience: all retrieval metrics for one ranked list.
export function scoreRanking(rankedIds, relevantIds, k) {
  return {
    k,
    recall: recallAtK(rankedIds, relevantIds, k),
    precision: precisionAtK(rankedIds, relevantIds, k),
    hitRate: hitRateAtK(rankedIds, relevantIds, k),
    mrr: reciprocalRank(rankedIds, relevantIds),
    ndcg: ndcgAtK(rankedIds, relevantIds, k),
  };
}

export function mean(values) {
  const xs = (values || []).filter((v) => typeof v === "number");
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Nearest-rank percentile over raw (unsorted ok) values. p in 0..100.
export function percentile(values, p) {
  const xs = (values || []).filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[rank];
}

export function summarizeLatencies(msValues) {
  const xs = (msValues || []).filter((v) => typeof v === "number");
  if (xs.length === 0) return null;
  const round3 = (n) => Math.round(n * 1000) / 1000;
  return {
    n: xs.length,
    mean: round3(mean(xs)),
    p50: round3(percentile(xs, 50)),
    p95: round3(percentile(xs, 95)),
    min: round3(Math.min(...xs)),
    max: round3(Math.max(...xs)),
  };
}
