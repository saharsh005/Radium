/**
 * Internet-research helpers (Phase 12).
 *
 * The upgrade over question-only keyword search:
 *   1. Concepts are mined from the workspace's own chunks, so web
 *      queries reflect what the user actually uploaded.
 *   2. Candidate papers are deduplicated and relevance-ranked —
 *      ranking is measured (relevance 0..1), not assumed.
 *   3. Provenance is explicit: INTERNAL (uploaded papers) vs
 *      EXTERNAL (web) evidence is never mixed without a label.
 *
 * All functions are pure and deterministic (no LLM, no network).
 */

// SSRF guard: web research may only contact these academic APIs.
// Query strings are caller-supplied; hostnames must never be.
export const ALLOWED_ACADEMIC_HOSTS = new Set([
  "api.crossref.org",
  "api.semanticscholar.org",
]);

export function assertAcademicUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error("Invalid research API URL");
  }
  if (!ALLOWED_ACADEMIC_HOSTS.has(host)) {
    throw new Error(`Blocked research API host: ${host}`);
  }
  return url;
}

const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "with", "that", "this", "from", "have",
  "has", "been", "their", "they", "what", "how", "why", "which", "does",
  "each", "used", "use", "can", "its", "not", "but", "all", "more", "also",
  "than", "into", "such", "these", "those", "will", "would", "there",
  "while", "both", "between", "across", "using", "based", "about", "paper",
  "papers", "study", "studies", "research", "novel", "proposed", "results",
]);

export function extractTerms(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

// Ordered, deduplicated content terms from the question itself.
export function questionKeywords(question, max = 8) {
  const seen = [];
  for (const t of extractTerms(question)) {
    if (!seen.includes(t)) seen.push(t);
    if (seen.length >= max) break;
  }
  return seen;
}

// Frequency-ranked workspace concepts. Terms appearing across MULTIPLE
// chunks (i.e. shared vocabulary of the uploaded papers) rank first —
// those are the research topics, methods and datasets worth searching.
export function extractWorkspaceConcepts(chunks, max = 10) {
  const stats = new Map(); // term → {count, chunks}
  for (const c of chunks || []) {
    const seenInChunk = new Set();
    for (const t of extractTerms(c.payload?.text ?? c.text)) {
      let s = stats.get(t);
      if (!s) {
        s = { count: 0, chunks: 0 };
        stats.set(t, s);
      }
      s.count++;
      if (!seenInChunk.has(t)) {
        seenInChunk.add(t);
        s.chunks++;
      }
    }
  }
  return [...stats.entries()]
    .map(([term, s]) => ({ term, ...s }))
    .sort((a, b) => b.chunks - a.chunks || b.count - a.count)
    .slice(0, max);
}

// Focused search queries: question-led, workspace-led, then a mix.
// Empty queries are dropped so APIs never receive blank searches.
export function buildSearchQueries(question, concepts, maxQueries = 3) {
  const qk = questionKeywords(question, 6);
  const ck = (concepts || []).map((c) => c.term);
  const queries = [
    qk.join(" "),
    ck.slice(0, 4).join(" "),
    [...qk.slice(0, 2), ...ck.slice(0, 2)].join(" "),
  ];
  const seen = new Set();
  return queries.map((q) => q.trim()).filter((q) => {
    if (!q || seen.has(q)) return false;
    seen.add(q);
    return true;
  }).slice(0, maxQueries);
}

function paperText(p) {
  return `${p.title || ""}\n${p.abstract || ""}`.toLowerCase();
}

// Relevance of a paper to query terms: title matches weigh double.
// Returns 0..1 (fraction of query terms found, title-weighted, capped).
export function scorePaper(paper, queryTerms) {
  const terms = queryTerms || [];
  if (terms.length === 0) return 0;
  const title = String(paper.title || "").toLowerCase();
  const body = paperText(paper);
  let hits = 0;
  for (const t of terms) {
    if (title.includes(t)) hits += 2;
    else if (body.includes(t)) hits += 1;
  }
  return Math.min(1, Math.round((hits / (terms.length * 2)) * 100) / 100);
}

export function rankPapers(papers, queryTerms) {
  return (papers || [])
    .map((p) => ({ ...p, origin: "EXTERNAL", relevance: scorePaper(p, queryTerms) }))
    .sort((a, b) => b.relevance - a.relevance);
}

// Deduplicate by DOI first, then by normalised title.
export function dedupePapers(papers) {
  const seenDoi = new Set();
  const seenTitle = new Set();
  const out = [];
  for (const p of papers || []) {
    const doi = String(p.doi || "").toLowerCase().trim();
    if (doi) {
      if (seenDoi.has(doi)) continue;
      seenDoi.add(doi);
    }
    const title = String(p.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!title) continue;
    if (seenTitle.has(title)) continue;
    seenTitle.add(title);
    out.push(p);
  }
  return out;
}
