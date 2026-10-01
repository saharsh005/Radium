#!/usr/bin/env node
/**
 * Radium RAG evaluation runner.
 *
 *   node eval/run.js              → offline suites (no infrastructure needed)
 *   node eval/run.js --live --workspace <id>
 *                                 → offline suites + live index probe
 *
 * Writes eval/runs/<timestamp>.json. Every number in the report was
 * measured in this process; nothing is estimated or fabricated.
 * Live-dependent stages report "skipped" with a reason when
 * infrastructure is unreachable — never fake values.
 *
 * Import-safe: importing this module has no side effects (CLI only runs
 * when executed directly), so routes/eval.js can reuse the suites.
 */
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { performance } from "perf_hooks";

import { classifyQuery, getRetrievalPlan, rerankChunks, diversifyChunks } from "../rag/retriever.js";
import { chunkDocument, CHUNK_STRATEGIES, getChunkConfig } from "../rag/chunker.js";
import { verifyAnswer } from "../rag/verify.js";
import { scoreRanking, mean } from "./metrics.js";
import { FIXTURE_PAGES, RETRIEVAL_FIXTURE, CLASSIFIER_FIXTURE, VERIFY_FIXTURE } from "./fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RUNS_DIR = path.join(__dirname, "runs");

function timed(fn) {
  const t0 = performance.now();
  const result = fn();
  return { result, ms: Math.round((performance.now() - t0) * 100) / 100 };
}

// ── Suite A: query classification ──────────────────────────
export function suiteClassifier() {
  const { result, ms } = timed(() =>
    CLASSIFIER_FIXTURE.map(([question, expected]) => ({
      question,
      expected,
      predicted: classifyQuery(question).type,
    }))
  );
  const correct = result.filter((r) => r.predicted === r.expected).length;
  return {
    name: "query-classification",
    accuracy: correct / result.length,
    correct,
    total: result.length,
    failures: result.filter((r) => r.predicted !== r.expected),
    latencyMs: ms,
  };
}

// ── Suite B: chunking invariants per strategy ──────────────
export function suiteChunking() {
  const strategies = {};
  for (const strategy of CHUNK_STRATEGIES) {
    const { result, ms } = timed(() => {
      const first = chunkDocument(FIXTURE_PAGES, { strategy });
      const second = chunkDocument(FIXTURE_PAGES, { strategy });
      return { first, second };
    });
    const { first, second } = result;
    const pages = FIXTURE_PAGES.length;
    const validPages = first.chunks.every(
      (c) => Number.isInteger(c.page) && c.page >= 1 && c.page <= pages
    );
    strategies[strategy] = {
      chunkCount: first.chunks.length,
      avgChars: Math.round(mean(first.chunks.map((c) => c.text.length)) ?? 0),
      validPages,
      deterministic: JSON.stringify(first.chunks) === JSON.stringify(second.chunks),
      latencyMs: ms,
    };
  // The env-selected strategy is named so CHUNK_STRATEGY=X comparisons
  // read directly off the run file.
  }
  return { name: "chunking-invariants", activeStrategy: getChunkConfig().strategy, strategies };
}

// ── Suite C: answer verification battery ───────────────────
export function suiteVerification() {
  const cases = VERIFY_FIXTURE.map((f) => {
    const { result: report, ms } = timed(() => verifyAnswer(f.answer, f.chunks));
    return {
      name: f.name,
      expectedVerdict: f.expectedVerdict,
      verdict: report.verdict,
      pass: report.verdict === f.expectedVerdict,
      citationCoverage: report.citationCoverage,
      latencyMs: ms,
    };
  });
  const pass = cases.filter((c) => c.pass).length;
  return { name: "answer-verification", passRate: pass / cases.length, pass, total: cases.length, cases };
}

// ── Suite D: retrieval ordering on synthetic candidates ────
export function suiteRetrieval() {
  const { query, relevantPdfIds, candidates } = RETRIEVAL_FIXTURE;
  const { result, ms } = timed(() => {
    const reranked = rerankChunks(query, candidates);
    return diversifyChunks(reranked, 5);
  });
  const rankedPdfIds = result.map((c) => c.pdfId);
  // rerankChunks clones chunk objects, so map back by text identity.
  // Relevant at chunk granularity: any chunk from a relevant PDF.
  const relevantChunkIdx = new Set(
    candidates.map((c, i) => (relevantPdfIds.includes(c.pdfId) ? `c${i}` : null)).filter(Boolean)
  );
  const indexByText = new Map(candidates.map((c, i) => [c.text, `c${i}`]));
  const rankedChunkIds = result.map((c) => indexByText.get(c.text));
  const ks = [1, 3, 5];
  return {
    name: "retrieval-ordering",
    query,
    rankedPdfIds,
    distinctDocs: new Set(rankedPdfIds).size,
    metricsByK: Object.fromEntries(ks.map((k) => [k, scoreRanking(rankedChunkIds, [...relevantChunkIdx], k)])),
    plan: getRetrievalPlan(classifyQuery(query).type, classifyQuery(query).multiDoc),
    latencyMs: ms,
  };
}

// ── Suite E: live index probe (opt-in) ─────────────────────
export async function suiteLiveProbe(workspaceId) {
  const suite = { name: "live-index-probe", workspaceId, status: "skipped", reason: null };
  if (!workspaceId) {
    suite.reason = "no --workspace id provided";
    return suite;
  }
  try {
    const { createQdrantClient } = await import("../utils/qdrant.js");
    const qdrant = createQdrantClient({ timeout: 10_000 });
    const collection = `workspace_${workspaceId}`;
    const count = await qdrant.count(collection, { exact: true });
    const scroll = await qdrant.scroll(collection, { limit: 1, with_payload: true, with_vector: false });
    const payload = scroll.points?.[0]?.payload || {};
    suite.status = "ok";
    suite.points = count.count;
    suite.payloadKeys = Object.keys(payload);
    // Embedding health check is CLI-local (no network beyond Qdrant).
    const { getEmbedding } = await import("../utils/embeddings.js");
    const vec = await getEmbedding("health check probe");
    suite.embeddingDim = vec.length;
    return suite;
  } catch (err) {
    suite.reason = err?.message ?? "unknown error";
    return suite;
  }
}

// ── Orchestration (shared by CLI + API) ────────────────────
export async function runEvalSuites({ live = false, workspaceId = null } = {}) {
  const suites = [suiteClassifier(), suiteChunking(), suiteVerification(), suiteRetrieval()];
  if (live) suites.push(await suiteLiveProbe(workspaceId));
  return {
    tool: "radium-eval/1",
    timestamp: new Date().toISOString(),
    node: process.version,
    live: live ? workspaceId || "(no workspace)" : false,
    suites: Object.fromEntries(suites.map((s) => [s.name, s])),
  };
}

export async function persistRun(run) {
  await mkdir(RUNS_DIR, { recursive: true });
  const filename = `${run.timestamp.replace(/[:.]/g, "-")}.json`;
  await writeFile(path.join(RUNS_DIR, filename), JSON.stringify(run, null, 2));
  return filename;
}

export function summarizeRun(run) {
  const lines = [];
  for (const s of Object.values(run.suites)) {
    if (s.name === "query-classification")
      lines.push(`classification : accuracy ${(s.accuracy * 100).toFixed(1)}% (${s.correct}/${s.total})`);
    if (s.name === "chunking-invariants") {
      lines.push(`chunking active : ${s.activeStrategy}`);
      for (const [k, v] of Object.entries(s.strategies))
        lines.push(`chunk/${k}${" ".repeat(Math.max(1, 14 - k.length))}: n=${v.chunkCount} avg=${v.avgChars}ch pagesOk=${v.validPages} deterministic=${v.deterministic}`);
    }
    if (s.name === "answer-verification")
      lines.push(`verification   : pass rate ${(s.passRate * 100).toFixed(1)}% (${s.pass}/${s.total})`);
    if (s.name === "retrieval-ordering") {
      const m3 = s.metricsByK[3];
      lines.push(`retrieval      : recall@3=${m3.recall} mrr=${m3.mrr} ndcg@3=${m3.ndcg?.toFixed(3)} docs=${s.distinctDocs}`);
    }
    if (s.name === "live-index-probe")
      lines.push(`live probe     : ${s.status}${s.reason ? ` (${s.reason})` : ` — ${s.points} points, embedDim=${s.embeddingDim}`}`);
  }
  return lines;
}

// ── CLI ────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const wsIdx = args.indexOf("--workspace");
  const workspaceId = wsIdx >= 0 ? args[wsIdx + 1] : process.env.EVAL_WORKSPACE_ID || null;

  const run = await runEvalSuites({ live, workspaceId });
  const filename = await persistRun(run);

  console.log(`\nRadium eval — ${run.timestamp} → eval/runs/${filename}`);
  for (const line of summarizeRun(run)) console.log(`  ${line}`);
  console.log("");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error("Eval run failed:", err?.message ?? err);
    process.exit(1);
  });
}
