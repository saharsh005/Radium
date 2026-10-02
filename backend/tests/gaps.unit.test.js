import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sampleExcerpts,
  parseGapResponse,
  gapFilenames,
  GAP_TYPES,
  EVIDENCE_LEVELS,
  LIMITATION_CUES,
  scoreLimitationZone,
  mineLimitationZones,
  applyGapScreen,
  toGapRecord,
  insertGapRecords,
  generateWorkspaceGaps,
} from "../rag/gaps.js";

function point(id, pdfId, fileName, page, section, text) {
  return { id, payload: { pdfId, fileName, page, section, text } };
}

const POINTS = [
  point("a1", "pdf-1", "paper-a.pdf", 2, "Methods", "We train a transformer model on log sequences for anomaly detection. ".repeat(6)),
  point("a2", "pdf-1", "paper-a.pdf", 4, "Results", "Accuracy reaches 94 percent on the HDFS benchmark dataset. ".repeat(6)),
  point("b1", "pdf-2", "paper-b.pdf", 3, "Limitations", "However the approach cannot generalise to changing log formats and remains difficult on complex sequences. ".repeat(6)),
  point("b2", "pdf-2", "paper-b.pdf", 7, "Conclusion", "Future work should study online adaptation to evolving systems. ".repeat(6)),
];

describe("sampleExcerpts", () => {
  it("labels excerpts with provenance and stays in budget", () => {
    const { excerpts, contextText } = sampleExcerpts(POINTS);
    assert.ok(excerpts.length > 0);
    assert.ok(contextText.length <= 1600);
    assert.deepEqual(excerpts.map((e) => e.ref), excerpts.map((_, i) => `E${i + 1}`));
    assert.equal(excerpts[0].filename, "paper-a.pdf");
    assert.equal(typeof excerpts[0].page, "number");
  });

  it("handles empty input", () => {
    assert.deepEqual(sampleExcerpts([]), { excerpts: [], contextText: "" });
  });
});

describe("parseGapResponse", () => {
  it("resolves evidence refs and measures confidence", () => {
    const { excerpts } = sampleExcerpts(POINTS);
    const gaps = parseGapResponse(
      { gaps: [{ title: "Temporal generalisation gap", description: "No study handles change.", type: "methodological gap", evidence: ["E3", "E9"] }] },
      excerpts
    );
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].type, "METHODOLOGICAL GAP");
    assert.equal(gaps[0].evidence.length, 1);
    assert.equal(gaps[0].evidence[0].ref, "E3");
    assert.equal(gaps[0].confidence, 0.5);
  });

  it("drops gaps with no resolvable evidence", () => {
    const { excerpts } = sampleExcerpts(POINTS);
    const gaps = parseGapResponse(
      { gaps: [{ title: "Invented gap", description: "Nope.", type: "EMPIRICAL GAP", evidence: ["E99"] }] },
      excerpts
    );
    assert.deepEqual(gaps, []);
  });

  it("normalises unknown types and is deterministic", () => {
    const { excerpts } = sampleExcerpts(POINTS);
    const parsed = { gaps: [{ title: "T", description: "D", type: "weird", evidence: ["e1"] }] };
    const a = parseGapResponse(parsed, excerpts);
    assert.equal(a[0].type, "RESEARCH GAP");
    assert.deepEqual(a, parseGapResponse(parsed, excerpts));
    assert.ok(GAP_TYPES.includes("EMPIRICAL GAP"));
  });
});

describe("gapFilenames", () => {
  it("collects referenced filenames in order, capped", () => {
    const { excerpts } = sampleExcerpts(POINTS);
    const gaps = parseGapResponse(
      { gaps: [{ title: "T", description: "D", type: "EMPIRICAL GAP", evidence: ["E1", "E3"] }] },
      excerpts
    );
    assert.deepEqual(gapFilenames(gaps), ["paper-a.pdf", "paper-b.pdf"]);
    assert.deepEqual(gapFilenames([]), []);
  });
});

describe("scoreLimitationZone / mineLimitationZones", () => {
  it("scores limitation language and sections higher", () => {
    const lim = scoreLimitationZone("However the model suffers on complex logs and future work remains.", "Limitations");
    const plain = scoreLimitationZone("We train a transformer model on log sequences.", "Methods");
    assert.ok(lim > plain);
    assert.ok(LIMITATION_CUES.includes("future work"));
  });

  it("ranks limitation-rich points first, stably", () => {
    const ranked = mineLimitationZones(POINTS);
    const topIds = ranked.slice(0, 2).map((z) => z.point.id).sort();
    assert.deepEqual(topIds, ["b1", "b2"]);
  });
});

describe("sampleExcerpts limitation priority", () => {
  it("reserves budget for limitation zones on larger inputs", () => {
    const many = [];
    for (let i = 0; i < 10; i++) {
      many.push(point(`m${i}`, "pdf-m", "methods.pdf", i + 1, "Methods", "We train model weights with gradient updates on batches. ".repeat(8)));
    }
    many.push(point("lim", "pdf-l", "limits.pdf", 11, "Limitations", "However the approach cannot handle long sequences and remains difficult. ".repeat(8)));
    const { excerpts } = sampleExcerpts(many, { sampleCount: 4, excerptLen: 120, maxContext: 2000 });
    assert.ok(excerpts.some((e) => e.filename === "limits.pdf"), "limitation zone must win budget");
  });
});

describe("parseGapResponse evidence levels", () => {
  it("validates levels, keeps chain fields, sorts speculative last", () => {
    const { excerpts } = sampleExcerpts(POINTS);
    const gaps = parseGapResponse({ gaps: [
      { title: "S", description: "D", type: "EMPIRICAL GAP", evidenceLevel: "SPECULATIVE", limitation: "L", reasoning: "R", evidence: ["E1"] },
      { title: "E", description: "D", type: "EMPIRICAL GAP", evidenceLevel: "EXPLICIT", limitation: "L2", reasoning: "R2", evidence: ["E2"] },
      { title: "W", description: "D", type: "EMPIRICAL GAP", evidenceLevel: "weird", evidence: ["E1"] },
    ] }, excerpts);
    assert.deepEqual(gaps.map((g) => g.evidenceLevel), ["EXPLICIT", "SUPPORTED_INFERENCE", "SPECULATIVE"]);
    assert.equal(gaps[0].limitation, "L2");
    assert.equal(gaps[0].reasoning, "R2");
    assert.ok(EVIDENCE_LEVELS.includes("STRONGLY_SUPPORTED"));
  });
});

describe("applyGapScreen", () => {
  it("rejects contradicted candidates, keeps the unsure", () => {
    const gaps = [{ title: "A" }, { title: "B" }, { title: "C" }];
    const { survivors, rejected } = applyGapScreen(gaps, { reviews: [
      { gapIndex: 0, contradicted: false, note: "ok" },
      { gapIndex: 1, contradicted: true, contradictingRefs: ["E2"], note: "Drain already does this" },
    ] });
    assert.deepEqual(survivors.map((g) => g.title), ["A", "C"]);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].note, /Drain/);
  });
});

describe("toGapRecord", () => {
  it("maps to snake_case row", () => {
    const row = toGapRecord("ws1", {
      title: "T", description: "D", type: "EMPIRICAL GAP", confidence: 1,
      limitation: "L", reasoning: "R", evidenceLevel: "EXPLICIT", evidence: [{ ref: "E1" }],
    }, ["a.pdf"], "verified");
    assert.equal(row.evidence_level, "EXPLICIT");
    assert.equal(row.verification, "verified");
    assert.equal(row.limitation, "L");
    assert.deepEqual(row.related_pdfs, ["a.pdf"]);
  });
});

describe("insertGapRecords", () => {
  function mockSupabase(failOn) {
    return { from: () => ({ insert: async (rows) => {
      const cols = Object.keys(rows[0]);
      const hit = failOn.find((c) => cols.includes(c));
      return hit ? { error: { message: `Could not find the '${hit}' column` } } : { error: null };
    } }) };
  }

  it("inserts fully on current schema", async () => {
    const r = await insertGapRecords(mockSupabase([]), [{ workspace_id: "w", evidence_level: "EXPLICIT", evidence: [] }]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.droppedColumns, []);
  });

  it("drops 003 then 002 columns progressively on old schemas", async () => {
    const r = await insertGapRecords(mockSupabase(["evidence_level", "evidence"]), [{ workspace_id: "w", evidence_level: "X", evidence: [], limitation: "L" }]);
    assert.equal(r.ok, true);
    assert.ok(r.droppedColumns.includes("evidence_level"));
    assert.ok(r.droppedColumns.includes("evidence"));
  });

  it("surfaces non-column errors immediately", async () => {
    const sb = { from: () => ({ insert: async () => ({ error: { message: "RLS denied" } }) }) };
    const r = await insertGapRecords(sb, [{ workspace_id: "w" }]);
    assert.equal(r.ok, false);
  });
});

describe("generateWorkspaceGaps", () => {
  const llmGaps = async () => ({ gaps: [
    { title: "Weak on complex logs", description: "Performance drops on BGL.", limitation: "Authors report difficulty with complex long sequences.", reasoning: "If complexity hurts, robust modelling of complex logs is the gap.", type: "EMPIRICAL GAP", evidenceLevel: "STRONGLY_SUPPORTED", evidence: ["E1"] },
    { title: "Parser myth gap", description: "No parser-free work exists.", limitation: "None stated.", reasoning: "Absence implies opportunity.", type: "METHODOLOGICAL GAP", evidenceLevel: "SPECULATIVE", evidence: ["E1"] },
  ] });
  const screen = async () => ({ reviews: [
    { gapIndex: 0, contradicted: false, note: "supported" },
    { gapIndex: 1, contradicted: true, contradictingRefs: ["E1"], note: "LAnoBERT itself is parser-free" },
  ] });

  it("runs sample → gaps → screen, rejecting contradictions", async () => {
    let calls = 0;
    const completeJson = async (prompt) => {
      calls++;
      return calls === 1 ? llmGaps(prompt) : screen(prompt);
    };
    const res = await generateWorkspaceGaps({ points: POINTS, completeJson });
    assert.equal(res.screened, true);
    assert.equal(res.gaps.length, 1);
    assert.equal(res.gaps[0].title, "Weak on complex logs");
    assert.equal(res.dropped.length, 1);
  });

  it("keeps gaps unscreened when the screen call fails", async () => {
    let calls = 0;
    const completeJson = async () => {
      calls++;
      if (calls === 1) return llmGaps();
      throw new Error("LLM down");
    };
    const res = await generateWorkspaceGaps({ points: POINTS, completeJson });
    assert.equal(res.screened, false);
    assert.equal(res.gaps.length, 2);
  });

  it("returns empty when the LLM call fails", async () => {
    const res = await generateWorkspaceGaps({ points: POINTS, completeJson: async () => { throw new Error("down"); } });
    assert.deepEqual(res.gaps, []);
    assert.match(res.error, /down/);
  });

  it("returns empty with no excerpts", async () => {
    const res = await generateWorkspaceGaps({ points: [], completeJson: async () => ({ gaps: [] }) });
    assert.deepEqual(res.gaps, []);
  });
});
