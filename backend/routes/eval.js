import express from "express";
import { readdir, readFile } from "fs/promises";
import path from "path";
import { clerkAuth } from "../middleware/auth.js";
import { runEvalSuites, persistRun, summarizeRun, RUNS_DIR } from "../eval/run.js";

const router = express.Router();

// All eval routes require authentication.
router.use(clerkAuth);

// ── Suite catalogue (no execution) ─────────────────────────
router.get("/suites", (req, res) => {
  res.json([
    { name: "query-classification", description: "12 pinned questions → type accuracy", live: false },
    { name: "chunking-invariants", description: "counts/sizes/page-validity/determinism per strategy", live: false },
    { name: "answer-verification", description: "verdict battery incl. refusal + adversarial", live: false },
    { name: "retrieval-ordering", description: "recall/precision/hit-rate/MRR/nDCG on synthetic candidates", live: false },
    { name: "live-index-probe", description: "Qdrant point count + embedding dim for a workspace", live: true },
  ]);
});

// ── Run offline suites now (fast, <1s) ─────────────────────
router.post("/run", async (req, res) => {
  try {
    const run = await runEvalSuites({ live: false });
    const runId = await persistRun(run);
    res.json({ runId, timestamp: run.timestamp, summary: summarizeRun(run), suites: run.suites });
  } catch (err) {
    res.status(500).json({ error: "Evaluation run failed", debug: err.message });
  }
});

// ── List stored runs (newest first) ────────────────────────
router.get("/runs", async (req, res) => {
  try {
    const files = (await readdir(RUNS_DIR)).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, 20);
    res.json(files.map((f) => ({ runId: f })));
  } catch (err) {
    if (err.code === "ENOENT") return res.json([]);
    res.status(500).json({ error: "Failed to list runs" });
  }
});

// ── Fetch one stored run (basename-guarded, no traversal) ──
router.get("/runs/:runId", async (req, res) => {
  try {
    const runId = path.basename(req.params.runId);
    if (!runId.endsWith(".json")) return res.status(400).json({ error: "Invalid run id" });
    const raw = await readFile(path.join(RUNS_DIR, runId), "utf8");
    res.json(JSON.parse(raw));
  } catch (err) {
    if (err.code === "ENOENT") return res.status(404).json({ error: "Run not found" });
    res.status(500).json({ error: "Failed to load run" });
  }
});

export default router;
