import express from "express";
import Groq from "groq-sdk";
import { clerkAuth } from "../middleware/auth.js";
import { supabase } from "../utils/supabase.js";
import { buildGapsPrompt, buildAbstractPrompt } from "../rag/prompts.js";
import { sampleExcerpts, parseGapResponse, gapFilenames } from "../rag/gaps.js";
import { createQdrantClient } from "../utils/qdrant.js";

const router = express.Router();
const qdrant = createQdrantClient();

let ai = null;
function getAi() {
  if (!ai) ai = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return ai;
}



// ── CREATE ──────────────────────────────────────────────────────────────────

router.post("/", clerkAuth, async (req, res) => {
  try {
    const { title } = req.body;
    const userId = req.auth.userId;
    if (!title?.trim()) return res.status(400).json({ error: "Workspace title required" });

    await supabase.from("users").upsert({ clerk_id: userId }, { onConflict: "clerk_id" });

    const { data, error } = await supabase
      .from("workspaces")
      .insert({ clerk_id: userId, title: title.trim() })
      .select("id, title, created_at")
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LIST ────────────────────────────────────────────────────────────────────

router.get("/", clerkAuth, async (req, res) => {
  // console.log("AUTH DEBUG:", req.auth);
  try {
    const { data, error } = await supabase
      .from("workspaces").select("id, title, created_at")
      .eq("clerk_id", req.auth.userId).order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET SINGLE ──────────────────────────────────────────────────────────────

router.get("/:id", clerkAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("workspaces").select("id, title, created_at")
      .eq("id", req.params.id).eq("clerk_id", req.auth.userId).single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE ──────────────────────────────────────────────────────────────────

router.delete("/:id", clerkAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from("workspaces").delete()
      .eq("id", req.params.id).eq("clerk_id", req.auth.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PDFs ────────────────────────────────────────────────────────────────────

router.get("/:id/pdfs", clerkAuth, async (req, res) => {
  try {
    // Select lifecycle columns when the 001 migration has been applied;
    // fall back to the base columns on older schemas.
    const { data, error } = await supabase
      .from("user_pdfs")
      .select("pdf_id, filename, uploaded_at, storage_path, status, chunk_count, indexed_at, error")
      .eq("workspace_id", req.params.id).eq("clerk_id", req.auth.userId)
      .order("uploaded_at", { ascending: false });
    if (error) {
      if (/column|status|chunk_count|indexed_at/i.test(error.message ?? "")) {
        const retry = await supabase
          .from("user_pdfs").select("pdf_id, filename, uploaded_at, storage_path")
          .eq("workspace_id", req.params.id).eq("clerk_id", req.auth.userId)
          .order("uploaded_at", { ascending: false });
        if (retry.error) throw retry.error;
        return res.json((retry.data || []).map((p) => ({ ...p, status: "UNKNOWN" })));
      }
      throw error;
    }
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CHATS ────────────────────────────────────────────────────────────────────

router.get("/:id/chats", clerkAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("chats").select("id, title, created_at")
      .eq("workspace_id", req.params.id).eq("clerk_id", req.auth.userId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── RESEARCH GAPS ────────────────────────────────────────────────────────────

// NOTE: excerpt sampling and evidence resolution live in rag/gaps.js,
// shared with the PDF worker so both gap paths behave identically.

// Citations built from a gap's resolved evidence — real files/pages,
// never a blind first-N list. Falls back only for legacy rows.
function evidenceCitations(gap, pdfNameMap, fallback) {
  const cites = [];
  for (const e of gap.evidence || []) {
    if (!e.pdfId && !e.filename) continue;
    cites.push({
      pdfId: e.pdfId || null,
      filename: e.filename || pdfNameMap[e.pdfId] || "Document",
      page: e.page ?? null,
      section: e.section ?? null,
    });
    if (cites.length >= 4) break;
  }
  return cites.length ? cites : fallback;
}

// ─── GET /:id/research-gaps ──────────────────────────────────────────────────
// Drop-in replacement for the route in your workspace router.
//
// Flow:
//   1. Check research_gaps table  →  return immediately if rows exist (free)
//   2. If no rows: sample Qdrant, call LLM, STORE results, then return
//      (so the next reload hits path 1, not the LLM again)

router.get("/:id/research-gaps", clerkAuth, async (req, res) => {
  try {
    const { id: workspaceId } = req.params;
    const userId = req.auth.userId;

    // ── Auth ────────────────────────────────────────────────────────────────
    const { data: ws, error: wsErr } = await supabase
      .from("workspaces")
      .select("id")
      .eq("id", workspaceId)
      .eq("clerk_id", userId)
      .single();
    if (wsErr || !ws) return res.status(404).json({ error: "Workspace not found" });

    // ── Fetch PDFs for citations (needed in both paths) ─────────────────────
    const { data: pdfs } = await supabase
      .from("user_pdfs")
      .select("pdf_id, filename")
      .eq("workspace_id", workspaceId)
      .eq("clerk_id", userId);

    const pdfNameMap       = Object.fromEntries((pdfs || []).map(p => [p.pdf_id, p.filename]));
    const defaultCitations = Object.entries(pdfNameMap)
      .slice(0, 3)
      .map(([pid, filename]) => ({ pdfId: pid, filename }));

    // ── Path 1: return stored gaps (no LLM call) ────────────────────────────
    // The `evidence` column needs migration 002; retry without it on
    // older schemas (those rows get fallback citations).
    let storedGaps = null;
    {
      const withEvidence = await supabase
        .from("research_gaps")
        .select("id, gap_text, gap_type, confidence, related_pdfs, evidence, created_at")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: true }); // ascending = insertion order
      if (withEvidence.error && /column|evidence/i.test(withEvidence.error.message ?? "")) {
        const legacy = await supabase
          .from("research_gaps")
          .select("id, gap_text, gap_type, confidence, related_pdfs, created_at")
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: true });
        if (legacy.error) throw legacy.error;
        storedGaps = legacy.data;
      } else {
        if (withEvidence.error) throw withEvidence.error;
        storedGaps = withEvidence.data;
      }
    }

    if (storedGaps?.length) {
      return res.json(storedGaps.map((gap, index) => {
        const lines       = (gap.gap_text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const title       = lines[0] || `Gap ${index + 1}`;
        const description = lines.slice(1).join(" ").trim();
        return {
          id:          gap.id,
          title,
          description,
          type:        gap.gap_type || "RESEARCH GAP",
          confidence:  gap.confidence ?? 0,
          evidence:    Array.isArray(gap.evidence) ? gap.evidence : [],
          citations:   evidenceCitations(gap, pdfNameMap, defaultCitations),
        };
      }));
    }

    // ── Path 2: no stored gaps yet — generate, store, then return ───────────
    if (!pdfs?.length) return res.json([]);

    // Sample Qdrant (same helper as worker — keeps behaviour identical)
    const collectionName = `workspace_${workspaceId}`;
    let allChunks = [];
    try {
      const result = await qdrant.scroll(collectionName, {
        filter: { must: [{ key: "workspaceId", match: { value: workspaceId } }] },
        limit: 200,
        with_payload: true,
      });
      allChunks = result.points || [];
    } catch (qdrantErr) {
      console.warn("Qdrant scroll failed:", qdrantErr.message);
      return res.json([]);
    }

    if (!allChunks.length) return res.json([]);

    // Same provenance-labelled sampling as the worker.
    const { excerpts, contextText } = sampleExcerpts(allChunks);
    if (!excerpts.length) return res.json([]);
    console.log(
      `📊 On-demand gap generation: ${allChunks.length} chunks → ${contextText.length} chars sampled`
    );

    const prompt = buildGapsPrompt(contextText);
    const completion = await getAi().chat.completions.create({
      model:           "llama-3.3-70b-versatile",
      messages:        [{ role: "user", content: prompt }],
      temperature:     0.3,
      max_tokens:      1500,
      response_format: { type: "json_object" },
    });

    const rawContent = completion?.choices?.[0]?.message?.content;
    let parsed = { gaps: [] };
    if (rawContent) {
      try { parsed = JSON.parse(rawContent); }
      catch (e) { console.warn("Gap parse error:", e); }
    }

    const gaps = parseGapResponse(parsed, excerpts);
    if (!gaps.length) return res.json([]);

    // ── Store so future reloads are free ────────────────────────────────────
    const relatedPdfs = gapFilenames(gaps);

    const records = gaps.map((gap) => ({
      workspace_id: workspaceId,
      gap_text: [gap.title, gap.description].filter(Boolean).join("\n\n"),
      gap_type:     gap.type,
      confidence:   gap.confidence,
      related_pdfs: relatedPdfs,
      evidence:     gap.evidence, // needs migration 002; dropped on older schemas
    }));

    // Fire-and-forget — don't block the response on the insert
    (async () => {
      let { error } = await supabase.from("research_gaps").insert(records);
      if (error && /column|evidence/i.test(error.message ?? "")) {
        const legacy = records.map(({ evidence: _dropped, ...row }) => row);
        ({ error } = await supabase.from("research_gaps").insert(legacy));
      }
      if (error) console.warn("Could not store on-demand research gaps:", error.message);
      else console.log(`✅ Stored ${records.length} on-demand gaps for workspace ${workspaceId}`);
    })();

    // Return immediately with the generated gaps (using temp ids)
    return res.json(gaps.map((gap, i) => ({
      id:          `gap-${i}`,          // real uuid arrives on next reload from DB
      title:       gap.title,
      description: gap.description,
      type:        gap.type,
      confidence:  gap.confidence,
      evidence:    gap.evidence,
      citations:   evidenceCitations(gap, pdfNameMap, defaultCitations),
    })));

  } catch (err) {
    console.error("Research gaps error:", err);
    res.status(500).json({ error: "Failed to generate research gaps" });
  }
});

// ── GENERATE ABSTRACT ────────────────────────────────────────────────────────

router.post("/:id/generate-abstract", clerkAuth, async (req, res) => {
  try {
    const { id: workspaceId } = req.params;
    const userId = req.auth.userId;
    const { gapTitle, gapDescription } = req.body;
    if (!gapTitle) return res.status(400).json({ error: "gapTitle required" });
 
    const { data: ws, error: wsErr } = await supabase
      .from("workspaces").select("id").eq("id", workspaceId).eq("clerk_id", userId).single();
    if (wsErr || !ws) return res.status(404).json({ error: "Workspace not found" });
 
    const { data: pdfMeta } = await supabase
      .from("user_pdfs").select("pdf_id, filename").eq("workspace_id", workspaceId).eq("clerk_id", userId);
 
    const collectionName = `workspace_${workspaceId}`;
    let allChunks = [];
    try {
      const result = await qdrant.scroll(collectionName, {
        filter: { must: [{ key: "workspaceId", match: { value: workspaceId } }] },
        limit: 200,
        with_payload: true,
      });
      allChunks = result.points || [];
    } catch (e) {
      console.warn("Qdrant scroll failed for abstract:", e.message);
    }
 
    // Use sampled context — not full dump
    const contextText = sampleChunks(allChunks, 15, 500, 3000);
    const prompt      = buildAbstractPrompt(gapTitle, gapDescription, contextText, pdfMeta?.length || 0);
 
    const completion = await getAi().chat.completions.create({
      model:       "llama-3.3-70b-versatile",
      messages:    [{ role: "user", content: prompt }],
      temperature: 0.5,
      max_tokens:  800,
    });
 
    const abstract = completion?.choices?.[0]?.message?.content?.trim() || "No abstract generated.";
    res.json({
      abstract,
      sourceDocs: (pdfMeta || []).map(p => p.filename),
    });
  } catch (err) {
    console.error("Abstract error:", err);
    res.status(500).json({ error: "Failed to generate abstract" });
  }
});

export default router;
