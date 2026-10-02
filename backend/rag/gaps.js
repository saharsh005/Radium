/**
 * Evidence-backed research-gap pipeline (limitation-first).
 *
 * Paper → Evidence → Limitation → Verification → Candidate gap
 * → Cross-paper contradiction screen → Final gap.
 *
 * Limitation ≠ gap. Every candidate carries its unresolved limitation,
 * the inference that leads from limitation to gap, resolving evidence,
 * and an evidence level — never a bare "Gap: X".
 *
 * Shared by the PDF worker and the workspace route so both paths behave
 * identically. Pure helpers are unit-tested; LLM calls enter only through
 * the injected completeJson(prompt) adapter.
 */
import { buildGapsPrompt, buildGapScreenPrompt } from "./prompts.js";

export const GAP_TYPES = [
  "METHODOLOGICAL GAP",
  "THEORETICAL GAP",
  "EMPIRICAL GAP",
  "APPLICATION GAP",
  "POPULATION GAP",
];

// Evidence levels, strongest first. Only non-SPECULATIVE gaps are
// presented as findings; SPECULATIVE ones are labelled "requires
// verification" and sorted last.
export const EVIDENCE_LEVELS = [
  "EXPLICIT",           // authors directly state the limitation / future work
  "STRONGLY_SUPPORTED", // experiments demonstrate it and authors discuss it
  "SUPPORTED_INFERENCE",// derived from documented limitations/results
  "SPECULATIVE",        // interesting but insufficiently evidenced
];
const LEVEL_RANK = { EXPLICIT: 0, STRONGLY_SUPPORTED: 1, SUPPORTED_INFERENCE: 2, SPECULATIVE: 3 };

export const DEFAULT_GAP_SAMPLING = {
  sampleCount: 8,
  excerptLen: 150,
  maxContext: 1600,
  // Share of the excerpt budget reserved for limitation-rich zones.
  // The rest stays stratified so contribution context is preserved
  // (gaps must not be mined from limitation snippets alone).
  limitationShare: 0.5,
};

// ─── Limitation-zone mining (no LLM, deterministic) ───────
export const LIMITATION_CUES = [
  "limitation", "however", "drawback", "challenge", "remains", "future work",
  "although", "despite", "cannot", "difficult", "suffers", "constrained",
  "depends on", "computational cost", "scalability", "fails", "degrades",
  "weakness", "threat", "unresolved", "insufficient", "struggles",
];
const LIMITATION_SECTIONS = [
  /limitation/i, /future work/i, /discussion/i, /conclusion/i,
  /threat/i, /weakness/i, /challenge/i, /evaluation/i, /result/i,
];

export function scoreLimitationZone(text, section) {
  const t = String(text || "").toLowerCase();
  let cues = 0;
  for (const cue of LIMITATION_CUES) {
    if (t.includes(cue)) cues++;
  }
  const sectionBonus = LIMITATION_SECTIONS.some((re) => re.test(String(section || ""))) ? 2 : 0;
  return cues + sectionBonus;
}

// Rank points by limitation-zone score (stable: ties keep index order).
export function mineLimitationZones(points) {
  return (points || [])
    .map((point, index) => ({
      point,
      index,
      score: scoreLimitationZone(point.payload?.text, point.payload?.section),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

/**
 * Stratified sample with limitation-zone priority.
 * @returns {{ excerpts, contextText }}
 */
export function sampleExcerpts(points, opts = {}) {
  const { sampleCount, excerptLen, maxContext, limitationShare } = { ...DEFAULT_GAP_SAMPLING, ...opts };
  const all = points || [];
  if (all.length === 0) return { excerpts: [], contextText: "" };

  // Half the budget: top limitation zones. Other half: stratified cover.
  const zoneCount = Math.min(all.length, Math.ceil(sampleCount * limitationShare));
  const zones = mineLimitationZones(all).slice(0, zoneCount);
  const zoneIds = new Set(zones.map((z) => z.point.id));

  const rest = all.filter((c) => !zoneIds.has(c.id));
  const step = Math.max(1, Math.floor(rest.length / Math.max(1, sampleCount - zoneCount)));
  const stratified = [];
  for (let i = 0; i < rest.length && stratified.length < sampleCount - zoneCount; i += step) {
    stratified.push(rest[i]);
  }
  const last = all[all.length - 1];
  const selected = [...zones.map((z) => z.point), ...stratified];
  if (selected.length > 0 && !selected.find((c) => c.id === last.id)) selected.push(last);

  // Document order for prompt readability.
  const order = new Map(all.map((c, i) => [c.id, i]));
  selected.sort((a, b) => order.get(a.id) - order.get(b.id));

  const excerpts = [];
  let contextText = "";
  selected.forEach((c) => {
    const p = c.payload || {};
    const text = String(p.text || "").slice(0, excerptLen).replace(/\s+/g, " ").trim();
    if (!text) return;
    const ref = `E${excerpts.length + 1}`;
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
 * Drops gaps with no resolvable evidence. Confidence is MEASURED:
 * resolvedRefs / claimedRefs — never an LLM self-estimate.
 * Sorted strongest-evidence-first; SPECULATIVE last.
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
    const level = String(g.evidenceLevel || g.evidence_level || "SUPPORTED_INFERENCE").trim().toUpperCase();
    gaps.push({
      title: String(g.title || `Research Gap ${index + 1}`).trim().slice(0, 200),
      description: String(g.description || "").trim().slice(0, 1000),
      limitation: String(g.limitation || "").trim().slice(0, 1000),
      reasoning: String(g.reasoning || "").trim().slice(0, 1000),
      type: GAP_TYPES.includes(type) ? type : "RESEARCH GAP",
      evidenceLevel: EVIDENCE_LEVELS.includes(level) ? level : "SUPPORTED_INFERENCE",
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

  gaps.sort((a, b) => LEVEL_RANK[a.evidenceLevel] - LEVEL_RANK[b.evidenceLevel]);
  return gaps;
}

// Apply a contradiction-screen review: drop candidates the workspace
// evidence contradicts (already addressed). Returns survivors + rejects.
export function applyGapScreen(gaps, review) {
  const reviews = Array.isArray(review?.reviews) ? review.reviews : [];
  const byIndex = new Map(reviews.map((r) => [r.gapIndex, r]));
  const survivors = [];
  const rejected = [];
  gaps.forEach((gap, i) => {
    const r = byIndex.get(i);
    if (r?.contradicted === true) {
      rejected.push({ gap, note: String(r.note || "contradicted by workspace evidence").slice(0, 500) });
    } else {
      survivors.push(gap);
    }
  });
  return { survivors, rejected };
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

// Map a pipeline gap to a research_gaps row (snake_case columns).
export function toGapRecord(workspaceId, gap, relatedPdfs, verification) {
  return {
    workspace_id: workspaceId,
    gap_text: [gap.title, gap.description].filter(Boolean).join("\n\n"),
    gap_type: gap.type,
    confidence: gap.confidence,
    related_pdfs: relatedPdfs,
    evidence: gap.evidence,
    evidence_level: gap.evidenceLevel,
    limitation: gap.limitation || null,
    reasoning: gap.reasoning || null,
    verification,
  };
}

// Insert with progressive column fallback for pre-migration schemas:
// full → without 003 columns → without 003 + evidence (002).
const GAP_COLUMN_STAGES = [
  [],
  ["limitation", "reasoning", "evidence_level", "verification"],
  ["limitation", "reasoning", "evidence_level", "verification", "evidence"],
];
export async function insertGapRecords(supabase, records) {
  let lastErr = null;
  const droppedAll = [];
  for (const drop of GAP_COLUMN_STAGES) {
    const rows = drop.length
      ? records.map((r) => {
          const c = { ...r };
          drop.forEach((k) => delete c[k]);
          return c;
        })
      : records;
    const { error } = await supabase.from("research_gaps").insert(rows);
    if (!error) return { ok: true, droppedColumns: [...droppedAll, ...drop] };
    if (!/column/i.test(error.message ?? "")) return { ok: false, error };
    lastErr = error;
    droppedAll.push(...drop);
  }
  return { ok: false, error: lastErr };
}

/**
 * Full pipeline: sample → layered gaps → contradiction screen.
 * completeJson(prompt) must resolve to the parsed JSON object (or throw).
 */
export async function generateWorkspaceGaps({ points, completeJson, sampling } = {}) {
  const { excerpts, contextText } = sampleExcerpts(points, sampling);
  if (!excerpts.length) return { gaps: [], excerpts: [], screened: false, dropped: [] };

  let parsed;
  try {
    parsed = await completeJson(buildGapsPrompt(contextText));
  } catch (err) {
    return { gaps: [], excerpts, screened: false, dropped: [], error: err.message };
  }
  const gaps = parseGapResponse(parsed, excerpts);
  if (!gaps.length) return { gaps, excerpts, screened: false, dropped: [] };

  // Contradiction screen: one bounded call; skipped (not failed) on error.
  try {
    const review = await completeJson(buildGapScreenPrompt(contextText, gaps));
    const { survivors, rejected } = applyGapScreen(gaps, review);
    return { gaps: survivors, excerpts, screened: true, dropped: rejected };
  } catch {
    return { gaps, excerpts, screened: false, dropped: [] };
  }
}
