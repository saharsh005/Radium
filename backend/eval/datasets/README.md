# Radium evaluation — dataset format & methodology

## Formats

- **Live workspace dataset:** `datasets/workspace-template.json` — fill the
  `FILL` placeholders after uploading 2–4 known papers to a workspace.
  Question object: `id, question, question_type, expected_answer,
  relevant_documents (pdf_ids), relevant_pages, notes`.
- **Offline fixtures (runnable now):** `eval/fixtures.js` — synthetic,
  deterministic, zero infrastructure. Used by `node eval/run.js` and the
  unit tests.

## Question categories (all must be represented)

factual · multi-hop · multi-document · comparison · methodology ·
limitation · research-gap · citation · unanswerable · adversarial

Unanswerable/adversarial questions are first-class: the correct behaviour
is **refusal** (`refused:true`), never a fabricated answer.

## Metrics

- Retrieval: Recall@K, Precision@K, Hit Rate, MRR, nDCG (`eval/metrics.js`).
- Generation: verdict distribution (supported / partially-supported /
  needs-review / refused), citation coverage, invalid-citation count
  (`rag/verify.js` via the chat route's `verification` field).
- System: per-stage latency (retrieve / rerank / LLM / verify), recorded
  in server logs (`rag_chat` event) and run files.

## Running

```bash
cd backend
node eval/run.js                    # offline suites → eval/runs/<ts>.json
node eval/run.js --live --workspace <id>   # + live index probe
npm test                            # unit tests incl. metrics + fixtures
```

## Comparing strategies (example)

```bash
CHUNK_STRATEGY=fixed    node eval/run.js   # chunk counts/avg sizes per strategy
CHUNK_STRATEGY=section-aware node eval/run.js
```

Chunk counts, sizes, determinism and page validity per strategy are in
every run file under `suites.chunking-invariants`. Retrieval/generation
comparisons need the live dataset above (Qdrant + Groq required).

## Rules

- Every reported number must come from a run file. No estimates.
- A suite that cannot run reports `skipped` + reason, never zeros.
- Thresholds in `rag/verify.js` are uncalibrated defaults until a live
  dataset calibrates them — see `VERIFY_DEFAULTS`.
