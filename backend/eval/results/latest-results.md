# Radium measured results — 2026-10-01T15:34:52.693Z

Tool: `radium-bench/1`, Node v24.14.1. Every number below was measured in-process unless marked NOT MEASURED.

## 1. Dataset

- Offline fixtures (`backend/eval/fixtures.js`, synthetic, deterministic): 6-page paper; 5 retrieval candidates (1 high-score distractor, 2 relevant); 12 classifier questions; 4 verification cases.
- Perf inputs: 12-question batch; 5-candidate rerank+diversify; 6-claim answer + 2 chunks; 20-page synthetic doc per chunking strategy.
- Live workspace dataset: template only (`backend/eval/datasets/workspace-template.json`) — no labelled PDFs available in this environment, so no production retrieval/answer labels exist. Relevance labels were NOT fabricated.

## 2. Retrieval metrics

- Production Recall@5 / Recall@10 / Precision@5 / MRR / nDCG@5 / retrieval latency: **NOT MEASURED** (no Qdrant, no labels).
- Synthetic ordering fixture (production code, non-production data): recall@3=0.5, mrr=1, ndcg@3=0.613, distinctDocs=3.

## 3. Answer / grounding metrics

- Verification battery (programmatic, 4 cases): pass rate 100% (4/4). No LLM judge was used.
- Live faithfulness / answer relevance: **NOT MEASURED**.

## 4. Citation metrics

- Invented-citation detection (`[99]` with 2 sources → flagged invalid): covered by unit tests, passing.
- Live citation correctness / completeness / unsupported-claim rate: **NOT MEASURED**.

## 5. Latency / performance metrics

- classify (12-question batch): mean 0.182ms, p50 0.184ms, p95 0.293ms (n=50).
- rerank+diversify (5 candidates): mean 0.02ms, p50 0.009ms, p95 0.058ms (n=50).
- verifyAnswer (6 claims): mean 0.413ms, p50 0.323ms, p95 0.723ms (n=30).
- chunk/section-aware (22368 chars, 20 pages → 40 chunks): mean 1.321ms, p50 1.295ms, p95 2.28ms, ~16900000 chars/sec (n=11).
- chunk/paragraph (22368 chars, 20 pages → 24 chunks): mean 0.641ms, p50 0.622ms, p95 0.786ms, ~34900000 chars/sec (n=11).
- chunk/fixed (22368 chars, 20 pages → 35 chunks): mean 0.36ms, p50 0.233ms, p95 0.825ms, ~62100000 chars/sec (n=11).
- chunk/recursive (22368 chars, 20 pages → 31 chunks): mean 0.21ms, p50 0.177ms, p95 0.333ms, ~107000000 chars/sec (n=11).
- Embedding: dim 384, 230.34ms.
- PDF indexing time / retrieval / LLM / end-to-end latency: **NOT MEASURED** (needs live pipeline).

## 6. Reliability / security results

- Automated tests: **88/88 passing** (fail 0).
- Rate limiting (real server, 130 sequential GET /workspace): allowed=120, blocked429=10, enforced=true.
- Empty-evidence refusal: route path NOT MEASURED live (needs Qdrant); programmatic refusal short-circuit covered by unit tests + verification battery case, passing.
- Citation validation: unit-tested (in-range accepted, invented flagged), passing.
- Prompt-injection framing: verified present in RAG prompt by unit test; end-to-end adversarial behaviour NOT MEASURED (needs LLM).

## 7. Failed / unsupported measurements

- Live retrieval quality, live grounding/answer quality, live citation metrics, indexing/retrieval/LLM/e2e latency, embedding latency (if model unfetchable): all NOT MEASURED — details in JSON under each key.

## 8. Reproduction

```bash
cd backend
npm test            # A: test counts
node eval/run.js    # B: offline suites
node eval/bench.js  # this report (includes C–E)
```
Live (when services exist): index 2–4 labelled PDFs, fill `eval/datasets/workspace-template.json`, set EVAL_WORKSPACE_ID, run worker + `EVAL_LIVE=1 node eval/bench.js`.

## 9. Resume-safe metrics

- 88/88 automated backend tests passing (node:test, zero-dependency).
- Query classifier: 12/12 agreement on a pinned question set (heuristic, not ML accuracy).
- Answer verifier: 4/4 on a groundedness battery incl. hallucinated-citation and refusal cases (programmatic checks, no LLM judge).
- Chunking deterministic across 4 strategies with page-validity invariants (synthetic docs).
- Rate limiting enforced live against the API (130-request probe; 10 × 429 past the 120/min budget).
- Local RAG-helper latencies (n=50): rerank+diversify p95 0.058ms; claim verification p95 0.723ms; query classification p95 0.293ms per 12-question batch.
- Production retrieval quality (Recall@K/MRR/nDCG), live citation metrics, and end-to-end latency: NOT MEASURED — excluded until live-labelled evaluation runs.
