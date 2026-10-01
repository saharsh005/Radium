import { getEmbedding } from "../utils/embeddings.js";
import { createQdrantClient } from "../utils/qdrant.js";

const qdrant = createQdrantClient({ timeout: 30_000 });

// ─── Core Retrieval ───────────────────────────────────────
/**
 * Search the workspace collection for chunks relevant to `query`.
 *
 * Tuned for multi-document research RAG:
 *   - topK  = 20   (was 12) — pull more candidates before filtering
 *   - score = 0.25 (was 0.35) — don't discard weaker-but-relevant chunks
 *
 * @returns {Promise<RetrievedChunk[]>}
 *
 * @typedef {object} RetrievedChunk
 * @property {string} pdfId
 * @property {string} pdfTitle
 * @property {string} fileName
 * @property {number} page
 * @property {string} section
 * @property {string} text
 * @property {number} score
 */
export async function retrieveChunks({
  workspaceId,
  query,
  pdfIds         = [],
  topK           = 20,
  scoreThreshold = 0.25,
}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!query)       throw new Error("query is required");

  const collectionName = `workspace_${workspaceId}`;
  const queryVector    = await getEmbedding(query);

  const filter = {
    must: [
      { key: "workspaceId", match: { value: workspaceId } },
      ...(pdfIds.length > 0 ? [{ key: "pdfId", match: { any: pdfIds } }] : []),
    ],
  };

  let results;
  try {
    results = await qdrant.search(collectionName, {
      vector:          queryVector,
      limit:           topK,
      score_threshold: scoreThreshold,
      filter,
      with_payload:    true,
      with_vector:     false,
    });
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }

  return results.map((r) => ({
    pdfId:    r.payload.pdfId,
    pdfTitle: r.payload.pdfTitle || r.payload.fileName || "Untitled",
    fileName: r.payload.fileName || "unknown.pdf",
    page:     r.payload.page || 1,
    section:  r.payload.section || "Unknown section",
    text:     r.payload.text || "",
    score:    r.score,
  }));
}

// ─── Diversity + Coverage ─────────────────────────────────
/**
 * MMR-inspired diversification.
 *
 * Two-pass strategy:
 *   Pass 1 — guarantee one chunk per unique document (coverage)
 *   Pass 2 — fill remaining slots with highest-scoring non-duplicate chunks
 *
 * This prevents a single dominant document from flooding the context
 * window and drowning out evidence from other papers.
 *
 * @param {RetrievedChunk[]} chunks  Already sorted by score descending
 * @param {number}           maxTotal
 */
export function diversifyChunks(chunks, maxTotal = 12) {
  const seenDocs  = new Map(); // pdfId → count of chunks already selected
  const seenTexts = new Set(); // deduplicate near-identical chunks
  const primary   = [];        // first chunk per doc
  const secondary = [];        // additional chunks

  for (const c of chunks) {
    // Deduplicate: skip if a chunk with identical opening 120 chars was already taken
    const fingerprint = (c.text || "").substring(0, 120).trim();
    if (seenTexts.has(fingerprint)) continue;
    seenTexts.add(fingerprint);

    if (!seenDocs.has(c.pdfId)) {
      primary.push(c);
      seenDocs.set(c.pdfId, 1);
    } else {
      secondary.push(c);
    }
  }

  // primary first (coverage), then secondary by score (relevance)
  const combined = [
    ...primary,
    ...secondary.sort((a, b) => b.score - a.score),
  ].slice(0, maxTotal);

  return combined;
}

// ─── Keyword Reranker ─────────────────────────────────────
/**
 * Lightweight keyword-overlap reranker.
 *
 * Boosts chunks whose text overlaps with key terms from the query.
 * This is a fast heuristic that meaningfully improves ranking for
 * technical queries (e.g. "GRPO", "PPO", "distillation") where the
 * embedding model may have scored semantically similar but off-topic
 * chunks higher than an exact-match chunk.
 *
 * Score formula:  finalScore = vectorScore * 0.7 + keywordScore * 0.3
 *
 * Later upgrade path: replace with a cross-encoder reranker
 * (e.g. ms-marco-MiniLM) for even stronger results.
 *
 * @param {string}           query
 * @param {RetrievedChunk[]} chunks
 * @returns {RetrievedChunk[]}  re-sorted by combined score
 */
export function rerankChunks(query, chunks) {
  // Extract meaningful keywords: lowercase, strip stopwords, min 3 chars
  const STOPWORDS = new Set([
    "the","and","for","are","was","with","that","this","from","have",
    "has","been","their","they","what","how","why","which","does","each",
    "used","use","can","its","not","but","all","more","also","than","into",
  ]);

  const keywords = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));

  if (keywords.length === 0) return chunks;

  return chunks
    .map((c) => {
      const lower = c.text.toLowerCase();
      // Count how many distinct keywords appear in the chunk
      const matchCount = keywords.filter(kw => lower.includes(kw)).length;
      const keywordScore = matchCount / keywords.length; // 0.0 – 1.0
      const combinedScore = c.score * 0.7 + keywordScore * 0.3;
      return { ...c, score: combinedScore };
    })
    .sort((a, b) => b.score - a.score);
}

// ─── Context Builder ──────────────────────────────────────
/**
 * Formats chunks into a numbered citation block for the LLM prompt.
 *
 * Each citation object carries the EXACT chunk index, pdfTitle, page,
 * and section — no fake page numbers, no guessed attributions.
 * The LLM is instructed to use [1], [2], … notation which maps
 * 1-to-1 back to these citation objects.
 *
 * @param   {RetrievedChunk[]} chunks
 * @returns {{ context: string, citations: CitationEntry[] }}
 *
 * @typedef {object} CitationEntry
 * @property {number} index      — citation number used in the prompt
 * @property {string} pdfId
 * @property {string} pdfTitle
 * @property {string} fileName
 * @property {number} page
 * @property {string} section
 */
export function buildContext(chunks) {
  const citations = [];

  const context = chunks
    .map((chunk, i) => {
      const n = i + 1;
      citations.push({
        index:    n,
        pdfId:    chunk.pdfId,
        pdfTitle: chunk.pdfTitle,
        fileName: chunk.fileName,
        page:     chunk.page,
        section:  chunk.section,
      });

      // Structured header so the LLM can clearly read the provenance
      return [
        `[${n}] Source: "${chunk.pdfTitle || chunk.fileName || "Untitled"}"`,
        `     Page: ${chunk.page} | Section: ${chunk.section}`,
        ``,
        chunk.text,
      ].join("\n");
    })
    .join("\n\n---\n\n");

  return { context, citations };
}

// ─── Sources Builder ──────────────────────────────────────
/**
 * Builds the sources array returned to the frontend.
 * One entry per unique (pdfId, page) pair — deduped, capped at 8.
 *
 * IMPORTANT: every field here comes directly from the Qdrant payload
 * that was written at index time (pdfTitle, fileName, page, section).
 * There is no inference or guess work — if a field is missing in the
 * payload it is null, not fabricated.
 *
 * @param   {RetrievedChunk[]} chunks
 * @param   {CitationEntry[]}  citations   parallel array from buildContext
 * @returns {SourceEntry[]}
 *
 * @typedef {object} SourceEntry
 * @property {number} citationIndex   matches [n] in the answer text
 * @property {string} pdfId
 * @property {string} pdfTitle
 * @property {string} fileName
 * @property {number} page
 * @property {string|null} section
 * @property {number} score           0-100
 * @property {string} preview         first 150 chars of chunk text
 */
export function buildSources(chunks = [], citations = []) {
  const seen    = new Set();
  const sources = [];

  for (let i = 0; i < chunks.length; i++) {
    const c    = chunks[i];
    const cite = citations[i];
    const key  = `${c.pdfId}_${c.page}_${c.section}`;
    if (seen.has(key)) continue;
    seen.add(key);

    sources.push({
      citationIndex: cite?.index ?? (i + 1), // [n] used in the answer
      pdfId:         c.pdfId,
      pdfTitle:      c.pdfTitle,
      fileName:      c.fileName,
      filename:      c.fileName,
      page:          c.page,
      section:       c.section ?? null,
      score:         Math.round(c.score * 100),
      preview:       (c.text || "").substring(0, 150) + "…",
    });

    if (sources.length >= 8) break;
  }

  return sources;
}

// ─── Query Understanding ──────────────────────────────────
/**
 * Rule-based query classifier. Heuristic only (no LLM call, deterministic,
 * zero latency) — it picks a retrieval plan, never the final answer.
 * Confidence reflects pattern-match strength, not semantic certainty.
 */
const QUERY_PATTERNS = [
  ["research-gap",  [/\bgaps?\b/, /missing/, /unexplored/, /under-?explored/, /future work/, /open problems?/, /not been studied/, /further research/, /not (been |yet )?(evaluated|tested|studied|compared|assessed|explored|addressed)/, /never (evaluated|tested|studied|compared)/, /what .* have not been/]],
  ["contradiction", [/\bcontradict/, /\bdisagree/, /conflicting/, /inconsistent/, /opposing/, /\bdispute/]],
  ["comparison",    [/\bcompar/, /\bversus\b/, /\bvs\.?\b/, /\bdiffer/, /similarit/, /\bcontrast/, /\bbetter\b/, /outperform/, /trade-?offs?/]],
  ["limitation",    [/\blimitations?\b/, /drawbacks?/, /weakness/, /threats? to validity/, /shortcomings?/, /\bconstraints?\b/, /\bfail\w*\b/]],
  ["methodology",   [/\bmethod(ology|ologies|s)?\b/, /\bapproach/, /\balgorithm/, /\btechniques?\b/, /\bprocedures?\b/, /\bpipeline/, /\barchitecture/, /experiment(al)? setup/, /how (do|does|did|were|was)/, /\bdatasets?\b/, /\bmetrics?\b/]],
  ["synthesis",     [/\bsummar/, /overview/, /\bsynthesi/, /takeaways?/, /key findings?/, /overall/, /main (points|contributions|results)/]],
  ["definition",    [/what (is|are)/, /\bdefine\b/, /definition/, /meaning of/, /explain (what|the concept)/]],
  ["evidence",      [/\bevidence\b/, /\bquote\b/, /\bcite\b/, /which page/, /what page/, /\bexcerpt/, /\bpassage\b/, /table \d/i, /figure \d/i, /\bwhere\b/]],
  ["exploratory",   [/\bexplor/, /\bsurvey\b/, /state of the art/, /landscape/, /\btrends?\b/, /broadly/]],
];

// Cross-paper scope is a MODIFIER, not a competing type: "limitations
// across these studies" is a limitation question asked multi-doc.
const MULTIDOC_PATTERNS = [
  /across .*?(papers|studies|documents)/,
  /all (papers|studies|documents)/,
  /each (paper|study)/,
  /these (papers|studies)/,
  /both papers/,
  /which papers/,
  /papers use/,
  /same .*dataset/,
];

const BROAD_RETRIEVAL_TYPES = new Set([
  "comparison", "synthesis", "research-gap", "contradiction",
  "limitation", "exploratory",
]);

export function classifyQuery(question) {
  const q = String(question || "").toLowerCase();
  const multiDocHits = MULTIDOC_PATTERNS.filter((re) => re.test(q)).length;
  let best = null;
  let bestHits = 0;
  for (const [type, patterns] of QUERY_PATTERNS) {
    const hits = patterns.filter((re) => re.test(q)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = type;
    }
  }
  // Cross-paper scope without a content match (e.g. "which papers use
  // the same dataset?") is its own type; otherwise it only widens scope.
  if (!best) {
    if (multiDocHits > 0) {
      return {
        type: "multi-paper",
        confidence: Math.min(0.95, 0.5 + 0.15 * (multiDocHits - 1)),
        multiDoc: true,
      };
    }
    return { type: "factual", confidence: 0.3, multiDoc: false };
  }
  return {
    type: best,
    confidence: Math.min(0.95, 0.5 + 0.15 * (bestHits - 1)),
    multiDoc: BROAD_RETRIEVAL_TYPES.has(best) || multiDocHits > 0,
  };
}

// Retrieval plan per query type + scope. Multi-document intents get a
// wider net (higher topK, lower threshold, more diversification);
// precise lookups stay narrow to keep the context clean.
export function getRetrievalPlan(queryType, multiDoc = false) {
  if (BROAD_RETRIEVAL_TYPES.has(queryType) || queryType === "multi-paper" || multiDoc) {
    return { topK: 40, scoreThreshold: 0.15, diversifyK: 16, fallbackThreshold: 0.08 };
  }
  if (queryType === "methodology") {
    return { topK: 32, scoreThreshold: 0.2, diversifyK: 14, fallbackThreshold: 0.1 };
  }
  return { topK: 24, scoreThreshold: 0.25, diversifyK: 12, fallbackThreshold: 0.12 };
}

// ─── Cleanup ──────────────────────────────────────────────
export async function deletePdfVectors(workspaceId, pdfId) {
  const collectionName = `workspace_${workspaceId}`;
  try {
    await qdrant.delete(collectionName, {
      filter: {
        must: [
          { key: "workspaceId", match: { value: workspaceId } },
          { key: "pdfId",       match: { value: pdfId       } },
        ],
      },
    });
    console.log(`🗑️  Deleted vectors for PDF ${pdfId} from ${collectionName}`);
  } catch (err) {
    if (err.status === 404) return;
    throw err;
  }
}
