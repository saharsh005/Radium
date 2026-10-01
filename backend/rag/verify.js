/**
 * Answer verification (Phase 9, step 1: measurement, no extra LLM call).
 *
 * Pipeline: draft answer → claim extraction → citation validation →
 * claim-to-evidence matching → groundedness report.
 *
 * All matching is lexical and deterministic. Thresholds are config
 * defaults, NOT calibrated values — calibration needs the evaluation
 * dataset (Phase 13/14). The report is logged and returned so
 * groundedness is measured, never claimed.
 */

export const VERIFY_DEFAULTS = {
  supportThreshold: 0.3,   // best-chunk token recall ≥ this → supported
  weakThreshold: 0.15,     // ≥ this → weak; below → unsupported
  citedSupportThreshold: 0.15, // cited chunk must reach this, else miscited
  minClaimLength: 20,
};

const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "with", "that", "this", "from", "have",
  "has", "been", "their", "they", "what", "how", "why", "which", "does",
  "each", "used", "use", "can", "its", "not", "but", "all", "more", "also",
  "than", "into", "such", "these", "those", "will", "would", "there", "while",
  "both", "between", "across", "using", "based",
]);

const REFUSAL_PATTERNS = [
  /couldn't find sufficient evidence/i,
  /do not contain enough information/i,
  /insufficient evidence/i,
  /no relevant (information|evidence|chunks)/i,
];

export function isRefusalAnswer(answer) {
  return REFUSAL_PATTERNS.some((re) => re.test(String(answer || "")));
}

export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// Split an answer into candidate factual claims. Drops markdown
// structure, questions, very short fragments and refusal boilerplate.
export function extractClaims(answer) {
  const text = String(answer || "");
  if (!text.trim()) return [];
  const stripped = text
    .split("\n")
    .map((line) => line.replace(/^\s*(#{1,6}\s*|>\s*|[-*]\s+|\d+[.)]\s+)/, "").trim())
    .filter((line) => line.length > 0)
    .join(" ");
  const sentences = stripped
    .split(/(?<=[.!?])\s+(?=[A-Z"(0-9\[])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= VERIFY_DEFAULTS.minClaimLength);
  return sentences.filter(
    (s) => !s.endsWith("?") && !REFUSAL_PATTERNS.some((re) => re.test(s))
  );
}

// Every [n] must resolve to a real citation 1..citationCount.
// Catches invented citation numbers (e.g. [99] with 4 sources).
export function validateCitations(answer, citationCount) {
  const used = [];
  const re = /\[(\d+)\]/g;
  let m;
  while ((m = re.exec(String(answer || ""))) !== null) {
    used.push(parseInt(m[1], 10));
  }
  const unique = [...new Set(used)];
  const invalid = unique.filter((n) => n < 1 || n > citationCount);
  return { used: unique, invalid, valid: invalid.length === 0 };
}

// Fraction of the claim's content tokens present in the chunk text.
export function claimChunkScore(claim, chunkText) {
  const claimTokens = new Set(tokenize(claim));
  if (claimTokens.size === 0) return 0;
  const chunkTokens = new Set(tokenize(chunkText));
  let hits = 0;
  for (const t of claimTokens) if (chunkTokens.has(t)) hits++;
  return hits / claimTokens.size;
}

function citedIndices(claim, citationCount) {
  const out = [];
  const re = /\[(\d+)\]/g;
  let m;
  while ((m = re.exec(claim)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= citationCount) out.push(n);
  }
  return [...new Set(out)];
}

/**
 * @param {string} answer
 * @param {Array<{text:string}>} chunks  Retrieval hits (1-based citation order)
 * @param {object} [opts]  Threshold overrides
 * @returns verification report (JSON-serialisable, storable)
 */
export function verifyAnswer(answer, chunks = [], opts = {}) {
  const cfg = { ...VERIFY_DEFAULTS, ...opts };
  if (isRefusalAnswer(answer)) {
    return { verdict: "refused", claims: [], counts: {}, citationCoverage: null, invalidCitations: [] };
  }
  const claims = extractClaims(answer);
  const citationCheck = validateCitations(answer, chunks.length);

  const results = claims.map((claim) => {
    const cited = citedIndices(claim, chunks.length);
    let best = 0;
    let bestIndex = -1;
    chunks.forEach((c, i) => {
      const s = claimChunkScore(claim, c.text);
      if (s > best) {
        best = s;
        bestIndex = i + 1;
      }
    });
    const citedBest = cited.length
      ? Math.max(...cited.map((n) => claimChunkScore(claim, chunks[n - 1]?.text || "")))
      : null;

    let status;
    if (best < cfg.weakThreshold) status = "unsupported";
    else if (best < cfg.supportThreshold) status = "weak";
    else if (cited.length === 0) status = "supported-uncited";
    else if (citedBest < cfg.citedSupportThreshold) status = "miscited";
    else status = "supported";

    return { claim: claim.slice(0, 300), cited, bestScore: round3(best), bestChunk: bestIndex, citedScore: citedBest === null ? null : round3(citedBest), status };
  });

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const factual = results.length;
  const citedClaims = results.filter((r) => r.cited.length > 0).length;

  return {
    verdict: factual === 0
      ? "no-claims"
      : counts.unsupported > 0 || citationCheck.invalid.length > 0
        ? "needs-review"
        : counts.weak > 0 || counts["supported-uncited"] > 0 || counts.miscited > 0
          ? "partially-supported"
          : "supported",
    claims: results,
    counts,
    citationCoverage: factual ? round3(citedClaims / factual) : null,
    invalidCitations: citationCheck.invalid,
  };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
