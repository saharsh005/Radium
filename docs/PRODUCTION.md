# Radium Production Guide

## Prerequisites

Node 20+, Docker, Supabase project, Clerk app, Groq key.

## Environment

Backend (`backend/.env`): `PORT`, `FRONTEND_URL`, `NODE_ENV=production`,
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `CLERK_SECRET_KEY`, `GROQ_API_KEY`,
`QDRANT_URL`, `QDRANT_API_KEY` (if cloud), `REDIS_URL` (or
`REDIS_HOST/PORT/PASSWORD/TLS`), `SEMANTIC_SCHOLAR_KEY` (optional),
`CHUNK_STRATEGY` (section-aware|paragraph|fixed|recursive),
`CHUNK_TARGET/MIN/MAX/OVERLAP`, `RATE_LIMIT_WINDOW_MS/MAX`,
`RADIUM_RUN_WORKER` (leave unset in production).

Frontend (`frontend/.env`): `NEXT_PUBLIC_BACKEND_URL`,
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.

## Migrations (Supabase SQL editor, in order)

1. `backend/migrations/001_document_lifecycle.sql` — status lifecycle.
2. `backend/migrations/002_gap_evidence.sql` — gap evidence jsonb.
   (Both idempotent; the code tolerates unapplied schemas with fallbacks.)

Supabase also needs the `pdfs` storage bucket and the base tables
(`users, workspaces, user_pdfs, chats, messages, research_gaps`).

## Run (three processes + infra)

```bash
docker compose up -d redis qdrant
cd backend; npm start          # API :5000
cd backend; npm run worker     # PDF worker (required for indexing!)
cd frontend; npm run dev       # UI :3000
```

Health: `GET /health` (liveness), `GET /health/ready` (per-dependency,
200 ready / 503 degraded). Eval: `npm run eval`, API under `/eval`.

## Scaling notes

API, worker, eval, Qdrant, Redis scale independently. Run ≥2 worker
replicas for throughput (point IDs are deterministic → idempotent).
In-memory rate limits must move to Redis beyond one API replica.
`docker-compose.yml` currently lacks a worker service — add one running
`npm run worker` (plus healthchecks and a Redis volume) before
compose-based deploys.

## Known limitations (honest list)

- Retrieval/generation quality metrics NOT MEASURED on live data yet —
  fill `eval/datasets/workspace-template.json` and run the harness.
- `verifyAnswer` thresholds are uncalibrated defaults; verification is
  measurement-only (no auto-regeneration).
- Research-gap sampling is thin (~1,600 chars) by Groq-tier design;
  structured paper representation (datasets/metrics/claims tables) is future work.
- External papers are transient (not persisted); no cross-encoder
  reranker or BM25 index yet (keyword rerank + adaptive plans only).
- Page numbers depend on pdf.js reading order; scanned PDFs need OCR
  (rejected with a clear error today).
- Secrets are currently committed in `.env` files — rotate and gitignore.
