# Radium Architecture

AI-powered research-paper assistant: workspace-scoped RAG over uploaded
PDFs, with research-gap discovery, internet-augmented mode, and a
reproducible evaluation harness.

## Stack

| Layer | Tech |
|---|---|
| Frontend | Next.js 16 + React 19 + Clerk (`frontend/`) |
| API | Node 20+ + Express (`backend/server.js`, `backend/routes/`) |
| DB + object storage | Supabase + `pdfs` bucket (`backend/utils/supabase.js`) |
| Vectors | Qdrant, one collection per workspace: `workspace_{id}` |
| Queue | Redis + BullMQ `pdf-queue` (`backend/queue/`) |
| LLM | Groq `llama-3.3-70b-versatile` |
| Embeddings | Local Xenova `all-MiniLM-L6-v2` (384-dim, normalised) |

## Upload data flow

```
Browser (multipart/form-data + Clerk token)
→ POST /upload (clerkAuth + writeLimiter)
→ workspace ownership check → %PDF magic check → duplicate guard
→ Supabase Storage pdfs/{userId}/{pdfId}.pdf
→ user_pdfs row (status QUEUED; legacy fallback without it)
→ BullMQ job (attempts 5, exponential backoff)
→ 200 { pdfId, status: QUEUED }
```

Every stage rolls back on later failure (no orphan objects/rows).
Lifecycle: `QUEUED → PROCESSING → INDEXED`, failures
`UPLOAD_FAILED / PROCESSING_FAILED` (migration `001_document_lifecycle.sql`;
all writes tolerate pre-migration schemas).

## Indexing data flow (worker, `npm run worker`)

```
BullMQ job → download → extractPagesFromPdf (per-page via pagerender)
→ chunkDocument(pages) [CHUNK_STRATEGY, default section-aware]
→ embedBatch (concurrency 5, deterministic v5 point IDs)
→ dimension assert → Qdrant upsert → user_pdfs INDEXED
→ generateAndStoreResearchGaps
```

The API never runs the worker (opt-in `RADIUM_RUN_WORKER=true` only).

## Chat data flow

```
POST /chat (auth + ownership check on chat)
→ classifyQuery → getRetrievalPlan (narrow vs broad)
→ retrieveChunks (workspace+pdf filter, topK/threshold per plan)
→ fallback recall pass if <6 hits → rerank → diversify (per-doc cover)
→ zero hits? → persisted refusal, NO LLM call
→ buildContext ([n] citations from payload, never invented)
→ Groq JSON answer → verifyAnswer (claims/citations/support)
→ persist messages + structured rag_chat log → response
```

## Research gaps

Qdrant sample → provenance-labelled excerpts `[E1 | file p.N | section]`
→ LLM (evidence IDs mandatory) → `parseGapResponse` (drops unresolvable,
confidence = resolved/claimed, measured) → `research_gaps` (+ `evidence`
jsonb via migration `002_gap_evidence.sql`). Route serves stored rows or
generates on demand with the same helpers (`rag/gaps.js`).

## Internet research (`POST /chat/internet`)

Workspace concepts (mined from uploaded chunks) + LLM keywords →
up to 3 queries → CrossRef + Semantic Scholar (allowlisted hosts,
8s timeouts) → dedupe → relevance rank → top 8 →
synthesis with INTERNAL `[U n]` vs EXTERNAL `[E n]` attribution.
Own workspace authorisation enforced; external papers are transient
(`messages` has no papers column).

## Evaluation (`backend/eval/`)

`node eval/run.js` → offline suites (classification, chunking invariants,
verification battery, retrieval ordering) → `eval/runs/<ts>.json`.
`--live --workspace <id>` adds the index probe. API: `GET /eval/suites`,
`POST /eval/run`, `GET /eval/runs[/:id]`. Live workspace labelling format:
`eval/datasets/workspace-template.json`. Metrics: recall/P@K, hit rate,
MRR, nDCG; verdict distribution; citation coverage; per-stage latency.

## Security model

- Clerk verification fail-closed (`ALLOW_DEV_AUTH_BYPASS=true` = local only).
- Workspace/chat ownership checks on every route; Qdrant always filtered
  by `workspaceId` (+ `pdfId`), with payload indexes.
- Upload: magic bytes, 25 MB cap, sanitised names, duplicate guard.
- Rate limits: strict (30/min) on `/chat` + `/upload`, generous on reads.
- PDF/web text is UNTRUSTED: prompt boundary clauses + citation
  validation + refusal gate + verification (defence in depth, not prompt-only).
- Secrets only via env; logs carry scores/counts, never keys or tokens.
