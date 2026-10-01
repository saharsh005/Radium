import dotenv from "dotenv";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

import { Worker } from "bullmq";
import pdf from "pdf-parse/lib/pdf-parse.js";
import Groq from "groq-sdk";
import { getEmbedding } from "../utils/embeddings.js";
import { deterministicChunkId } from "../utils/ids.js";
import { createRedisConnection } from "./redisConnection.js";
import { createQdrantClient } from "../utils/qdrant.js";
import { chunkDocument, normaliseText } from "../rag/chunker.js";
import { sampleExcerpts, parseGapResponse, gapFilenames } from "../rag/gaps.js";
import { supabase } from "../utils/supabase.js";
import { buildGapsPrompt } from "../rag/prompts.js";

// ─── Config ───────────────────────────────────────────────
// Shared Redis options: supports REDIS_URL / rediss TLS (Upstash) as well
// as plain REDIS_HOST/REDIS_PORT. maxRetriesPerRequest stays null for
// BullMQ's blocking commands.
const REDIS_CONNECTION = createRedisConnection();

const QDRANT_URL  = process.env.QDRANT_URL || "http://localhost:6333";
const VECTOR_SIZE = 384;

let ai = null;
function getAi() {
  if (!ai) ai = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return ai;
}

async function generateAndStoreResearchGaps(workspaceId) {
  if (!workspaceId) return;
  const collectionName = `workspace_${workspaceId}`;
 
  const { points: allChunks } = await qdrant.scroll(collectionName, {
    filter: { must: [{ key: "workspaceId", match: { value: workspaceId } }] },
    limit: 100,
    with_payload: true,
  });
 
  if (!allChunks?.length) {
    console.log(`ℹ️  No chunks found for workspace ${workspaceId}, skipping gap generation.`);
    return;
  }
 
  // Provenance-labelled sampling (rag/gaps.js): each excerpt carries its
  // reference ID, file, page and section. Budget stays token-safe for the
  // Groq tier (≈1,600 chars of context).
  const { excerpts, contextText } = sampleExcerpts(allChunks);
  if (!excerpts.length) {
    console.log(`ℹ️  No usable excerpts for workspace ${workspaceId}, skipping gap generation.`);
    return;
  }

  console.log(`📊 Sending ${excerpts.length} excerpts (${contextText.length} chars / ~${Math.ceil(contextText.length / 4)} tokens) to LLM`);

  const prompt = buildGapsPrompt(contextText);
 
  const completion = await getAi().chat.completions.create({
    model:           "llama-3.3-70b-versatile",
    messages:        [{ role: "user", content: prompt }],
    temperature:     0.3,
    max_tokens:      1500,  // ↓ from 2000
    response_format: { type: "json_object" },
  });
 
  const rawContent = completion?.choices?.[0]?.message?.content;
  let parsed = { gaps: [] };
  if (rawContent) {
    try { parsed = JSON.parse(rawContent); }
    catch (parseErr) { console.warn("Research gaps parse error:", parseErr); }
  }
 
  // Evidence resolution: only gaps whose references resolve to real
  // sampled excerpts survive. Confidence = resolved/claimed (measured).
  const gaps = parseGapResponse(parsed, excerpts);
  if (!gaps.length) {
    console.log(`ℹ️  No evidence-backed gaps for workspace ${workspaceId} (LLM output had no resolvable evidence).`);
    return;
  }

  // Source PDFs are the ones actually referenced — never a blind first-3.
  const relatedPdfs = gapFilenames(gaps);

  const records = gaps.map((gap) => ({
    workspace_id: workspaceId,
    gap_text: [gap.title, gap.description].filter(Boolean).join("\n\n"),
    gap_type:     gap.type,
    confidence:   gap.confidence,
    related_pdfs: relatedPdfs,
    evidence:     gap.evidence, // needs migration 002; dropped on older schemas
  }));

  const { error: deleteErr } = await supabase
    .from("research_gaps")
    .delete()
    .eq("workspace_id", workspaceId);
  if (deleteErr) console.warn("Could not clear previous research gaps:", deleteErr.message);

  let { error: insertErr } = await supabase.from("research_gaps").insert(records);
  if (insertErr && /column|evidence/i.test(insertErr.message ?? "")) {
    // Pre-migration schema: retry without the evidence column.
    const legacy = records.map(({ evidence: _dropped, ...row }) => row);
    ({ error: insertErr } = await supabase.from("research_gaps").insert(legacy));
  }
  if (insertErr) console.warn("Could not store research gaps:", insertErr.message);
  else console.log(`✅ Stored ${records.length} evidence-backed gaps for workspace ${workspaceId}`);
}
 

const BATCH_SIZE    = 15;
// Embedding concurrency: the local transformer model runs on CPU, so a
// small pool beats sequential awaits without thrashing the event loop.
const EMBED_CONCURRENCY = 5;

const sleep  = (ms) => new Promise((res) => setTimeout(res, ms));
// Shared client: picks up QDRANT_URL + QDRANT_API_KEY and skips the
// version check (Qdrant Cloud needs the key on every request).
const qdrant = createQdrantClient({ timeout: 60_000 });

// Embed a batch with bounded concurrency. Failures propagate — the caller
// retries the whole batch (Qdrant upsert never sees partial vectors).
async function embedBatch(texts) {
  const out = new Array(texts.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(EMBED_CONCURRENCY, texts.length) },
    async () => {
      while (cursor < texts.length) {
        const i = cursor++;
        out[i] = await getEmbedding(texts[i]);
      }
    }
  );
  await Promise.all(runners);
  return out;
}

// ─── Qdrant Collection Setup ──────────────────────────────
/**
 * One collection per workspace  →  `workspace_{workspaceId}`
 *
 * All PDFs in the workspace share the collection.
 * At query time, filter by `workspaceId` (always) and optionally by
 * `pdfId` to scope the search to specific documents.
 *
 * Payload indices on workspaceId + pdfId make filtered search O(log n)
 * instead of a full scan.
 */
async function ensureCollection(name) {
  try {
    const info = await qdrant.getCollection(name);
    const size = info?.config?.params?.vectors?.size;
    if (size && size !== VECTOR_SIZE) {
      throw new Error(
        `Qdrant collection "${name}" uses vector size ${size} but the embedding model produces ${VECTOR_SIZE}. ` +
        `Delete or migrate the collection before re-indexing.`
      );
    }
    console.log("ℹ️  Collection already exists:", name);
    return;
  } catch (err) {
    // Our own size-mismatch error must propagate, never be treated as "missing".
    if (err.message?.includes("uses vector size")) throw err;
    const isNotFound = err.status === 404 || /not found/i.test(err.message ?? "");
    if (!isNotFound) throw err;
  }

  await qdrant.createCollection(name, {
    vectors: { size: VECTOR_SIZE, distance: "Cosine" },
  });
  console.log("✅ Created collection:", name);

  await qdrant.createPayloadIndex(name, {
    field_name:   "workspaceId",
    field_schema: "keyword",
  });
  await qdrant.createPayloadIndex(name, {
    field_name:   "pdfId",
    field_schema: "keyword",
  });
  console.log("✅ Payload indices created (workspaceId, pdfId)");
}

// ─── PDF metadata ─────────────────────────────────────────
/**
 * Fetch the human-readable file name and title for a PDF so every chunk
 * carries source attribution.  Adjust the select list to your schema.
 */
async function fetchPdfMeta(pdfId) {
  const { data, error } = await supabase
    .from("user_pdfs")
    .select("pdf_id, filename")
    .eq("pdf_id", pdfId)
    .single();

  if (error) {
    console.warn("⚠️  Could not fetch PDF metadata:", error.message);
    return { fileName: "unknown.pdf", pdfTitle: "Untitled" };
  }
  const name = data.filename || "unknown.pdf";
  const title = name.replace(/\.pdf$/i, "").trim() || name;
  return {
    fileName: name,
    pdfTitle: title,
  };
}

// ─── Per-Page PDF Extraction ────────────────────────────
/**
 * Extract text page-by-page so every chunk carries its REAL page number.
 * pdf-parse's `pagerender` hook is called once per page; we collect each
 * page's text separately instead of using the merged `parsed.text`
 * (which loses all page boundaries).
 *
 * @returns {Promise<{ pages: string[], numpages: number }>}
 *   pages[i] is the normalised text of page i+1.
 */
export async function extractPagesFromPdf(buffer) {
  const pages = [];
  const parsed = await pdf(buffer, {
    pagerender: async (pageData) => {
      const tc = await pageData.getTextContent();
      let text = "";
      for (const item of tc.items) {
        text += (item.str ?? "") + (item.hasEOL ? "\n" : " ");
      }
      // pdf.js item order is visual, not reading order — join then normalise.
      pages.push(normaliseText(text));
      return text;
    },
  });
  return { pages, numpages: parsed.numpages ?? pages.length };
}

// NOTE: section detection, chunking strategies and text normalisation live
// in rag/chunker.js (strategy registry, selectable via CHUNK_STRATEGY).
// This worker only orchestrates: download → extract → chunk → embed → index.

// ─── Main Worker ──────────────────────────────────────────
const pdfWorker = new Worker(
  "pdf-queue",
  async (job) => {
   const { pdfId, storagePath, userId, workspaceId } = job.data;

    console.log("➡️  Processing PDF:", pdfId, "| workspace:", workspaceId);

    try {
    // Best-effort status transition: UPLOADED/QUEUED → PROCESSING.
    // Missing `status` column on older schemas only produces a warning.
    const { error: processingErr } = await supabase
      .from("user_pdfs")
      .update({ status: "PROCESSING" })
      .eq("pdf_id", pdfId);
    if (processingErr) console.warn("⚠️  Could not mark PDF as PROCESSING:", processingErr.message);

    if (!storagePath) throw new Error("No storagePath in job data");
    if (!workspaceId) throw new Error("No workspaceId in job data");

    // 1. Download
    const { data: fileData, error: dlErr } = await supabase.storage
      .from("pdfs")
      .download(storagePath);
    if (dlErr) throw new Error("Download failed: " + dlErr.message);

    // 2. Parse (per-page, so citations carry real page numbers)
    const buffer = Buffer.from(await fileData.arrayBuffer());
    const { pages, numpages } = await extractPagesFromPdf(buffer);
    if (numpages === 0 || !pages.some((p) => p.trim().length > 0)) {
      throw new Error("PDF contains no extractable text (empty or scanned-image PDF; OCR is not supported)");
    }
    console.log("📑 Pages:", numpages, "| Text length:", pages.join("").length);

    // 3. Source metadata (carried into every chunk payload)
    const { fileName, pdfTitle } = await fetchPdfMeta(pdfId);
    console.log("📄 Document:", pdfTitle, "(", fileName, ")");

    // 4. Chunk via the strategy registry (CHUNK_STRATEGY; default
    // section-aware). Every chunk keeps its real page number.
    const { chunks, strategy } = chunkDocument(pages);
    console.log(`✂️  Chunking strategy: ${strategy} → ${chunks.length} chunks`);
    if (chunks.length === 0) {
      throw new Error("No indexable chunks produced (document may be too short or unparseable)");
    }

    // 5. Upsert into workspace-scoped Qdrant collection
    const collectionName = `workspace_${workspaceId}`;
    await ensureCollection(collectionName);

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch   = chunks.slice(i, i + BATCH_SIZE);
      let retries   = 0;

      while (retries < 3) {
        try {
          // Bounded-concurrency embeddings, then a single upsert.
          // Point IDs are deterministic (workspace:pdf:chunkIndex), so a
          // retried batch upserts the same points instead of duplicating.
          const vectors = await embedBatch(batch.map((c) => c.text));
          if (vectors[0]?.length !== VECTOR_SIZE) {
            throw new Error(
              `Embedding dimension ${vectors[0]?.length} does not match collection size ${VECTOR_SIZE}`
            );
          }
          const points = batch.map((c, j) => ({
            id:     deterministicChunkId(workspaceId, pdfId, c.chunkIndex),
            vector: vectors[j],
            payload: {
                // Identity — used for filtering at query time
                workspaceId,
                pdfId,
                userId,

                // Source attribution — returned with every chunk so the
                // answer layer can cite "pdfTitle, page N, section S"
                pdfTitle,
                fileName,

                // Content
                text:       c.text,
                page:       c.page,
                section:    c.section,
                chunkIndex: c.chunkIndex,
                chunkStrategy: strategy,

                createdAt: new Date().toISOString(),
              },
            }));
          await qdrant.upsert(collectionName, { points });
          console.log(
            `📦 Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(chunks.length / BATCH_SIZE)} ✅`
          );
          break;
        } catch (err) {
          retries++;
          if (retries >= 3) throw err;
          await sleep(1000 * retries);
        }
      }
      await sleep(300);
    }

    // 6. Mark PDF as indexed.
    // NOTE: the app's metadata table is `user_pdfs` keyed by `pdf_id`
    // (there is no `pdfs` table). The `status` field needs migration 001;
    // `indexed`/`chunk_count`/`indexed_at` already exist in production.
    const { error: updateErr } = await supabase
      .from("user_pdfs")
      .update({
        status:      "INDEXED",
        indexed:     true,
        chunk_count: chunks.length,
        indexed_at:  new Date().toISOString(),
      })
      .eq("pdf_id", pdfId);

    if (updateErr) {
      console.warn("⚠️  Could not update indexing status:", updateErr.message);
      // Fallback for schemas without the `status` column (pre-migration).
      const { error: fallbackErr } = await supabase
        .from("user_pdfs")
        .update({
          indexed:     true,
          chunk_count: chunks.length,
          indexed_at:  new Date().toISOString(),
        })
        .eq("pdf_id", pdfId);
      if (fallbackErr) console.warn("⚠️  Fallback status update failed:", fallbackErr.message);
    }

    try {
      await generateAndStoreResearchGaps(workspaceId);
      console.log("✅ Research gaps generated for workspace:", workspaceId);
    } catch (gapErr) {
      console.error("❌ Research gap generation failed:", gapErr);
    }

    console.log("✅ Done:", pdfId, "→", collectionName);
    } catch (jobErr) {
      // Best-effort failure marker so the UI never shows a job as
      // silently stuck, then rethrow so BullMQ records the failure
      // and applies the queue's retry/backoff policy.
      const { error: failErr } = await supabase
        .from("user_pdfs")
        .update({ status: "PROCESSING_FAILED" })
        .eq("pdf_id", job.data.pdfId);
      if (failErr) console.warn("⚠️  Could not mark PDF as failed:", failErr.message);
      console.error("❌ PDF job failed:", job.data.pdfId, "-", jobErr.message);
      throw jobErr;
    }
  },
  { connection: REDIS_CONNECTION, concurrency: 1 }
);

pdfWorker.on("error", (err) => {
  console.error("PDF worker error:", err?.message ?? err);
});

console.log("🚀 Radium PDF Worker running...");
