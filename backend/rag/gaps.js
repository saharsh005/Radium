/**
 * Evidence-backed research-gap helpers shared by the PDF worker
 * (post-indexing generation) and the workspace route (on-demand
 * generation). Every gap must resolve to REAL sampled excerpts —
 * unresolvable references are dropped, never presented as evidence.
 */

export const GAP_TYPES = [
  "METHODOLOGICAL GAP",
  "THEORETICAL GAP",
  "EMPIRICAL GAP",
  "APPLICATION GAP",
  "POPULATION GAP",
];

export const DEFAULT_GAP_SAMPLING = {
  sampleCount: 8,
  excerptLen: 150,
  maxContext: 1600,
};

/**
 * Stratified sample of chunks with provenance labels.
 * @param {Array} points  Qdrant points ({id, payload:{pdfId,fileName,pdfTitle,page,section,text}})
 * @returns {{ excerpts: Array<{ref,pdfId,filename,page,section,text}>, contextText: string }}
 */
export function sampleExcerpts(points, opts = {}) {
  const { sampleCount, excerptLen, maxContext } = { ...DEFAULT_GAP_SAMPLING, ...opts };
  const all = points || [];
  if (all.length === 0) return { excerpts: [], contextText: "" };

  const step = Math.max(1, Math.floor(all.length / sampleCount));
  const sampled = [];
  for (let i = 0; i < all.length && sampled.length < sampleCount; i += step) {
    sampled.push(all[i]);
  }
  const last = all[all.length - 1];
  if (sampled.length > 0 && sampled[sampled.length - 1].id !== last.id) sampled.push(last);

  const excerpts = [];
  let contextText = "";
  sampled.forEach((c, i) => {
    const ref = `E${i + 1}`;
    const p = c.payload || {};
    const text = String(p.text || "").slice(0, excerptLen).replace(/\s+/g, " ").trim();
    if (!text) return;
    const excerpt = {
      ref,
      pdfId: p.pdfId || null,
      filename: p.fileName || p.pdfTitle || "Document",
      page: p.page ?? null,
      section: p.section || null,
      text,
    };
    const block = `[${ref} | ${excerpt.filename}${excerpt.page ? ` p.${excerpt.page}` : ""}${excerpt.section ? ` | ${excerpt.section}` : ""}]\n${text}\n\n---\n\n`;
    if (contextText.length + block.length > maxContext) return;
    contextText += block;
    excerpts.push(excerpt);
  });

  return { excerpts, contextText: contextText.trim() };
}

/**
 * Validate an LLM gap response against the sampled excerpts.
 * Drops gaps with no resolvable evidence. Confidence is a MEASURED
 * quantity: resolvedRefs / claimedRefs — never an LLM self-estimate.
 */
export function parseGapResponse(parsed, excerpts) {
  const byRef = new Map((excerpts || []).map((e) => [e.ref, e]));
  const rawGaps = Array.isArray(parsed?.gaps) ? parsed.gaps : [];
  const gaps = [];

  rawGaps.forEach((g, index) => {
    const claimed = Array.isArray(g.evidence) ? g.evidence.map(String) : [];
    const resolved = [];
    for (const ref of claimed) {
      const hit = byRef.get(ref.toUpperCase());
      if (hit && !resolved.find((e) => e.ref === hit.ref)) resolved.push(hit);
    }
    // Gaps with zero resolvable evidence are speculation, not findings.
    if (resolved.length === 0) return;

    const type = String(g.type || "").trim().toUpperCase();
    gaps.push({
      title: String(g.title || `Research Gap ${index + 1}`).trim().slice(0, 200),
      description: String(g.description || "").trim().slice(0, 1000),
      type: GAP_TYPES.includes(type) ? type : "RESEARCH GAP",
      evidence: resolved.map((e) => ({
        ref: e.ref,
        pdfId: e.pdfId,
        filename: e.filename,
        page: e.page,
        section: e.section,
        quote: e.text.slice(0, 200),
      })),
      // Measured: what fraction of the claimed evidence actually resolves.
      confidence: claimed.length === 0 ? 0 : Math.round((resolved.length / claimed.length) * 100) / 100,
    });
  });

  return gaps;
}

// Filenames actually referenced by the gaps (for related_pdfs).
export function gapFilenames(gaps, max = 3) {
  const names = [];
  for (const g of gaps) {
    for (const e of g.evidence || []) {
      if (e.filename && !names.includes(e.filename)) names.push(e.filename);
      if (names.length >= max) return names;
    }
  }
  return names;
}
