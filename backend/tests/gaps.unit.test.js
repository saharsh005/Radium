import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sampleExcerpts,
  parseGapResponse,
  gapFilenames,
  GAP_TYPES,
} from "../rag/gaps.js";

function point(id, pdfId, fileName, page, section, text) {
  return { id, payload: { pdfId, fileName, page, section, text } };
}

const POINTS = [
  point("a1", "pdf-1", "paper-a.pdf", 2, "Methods", "We train a transformer model on log sequences for anomaly detection. ".repeat(6)),
  point("a2", "pdf-1", "paper-a.pdf", 4, "Results", "Accuracy reaches 94 percent on the HDFS benchmark dataset. ".repeat(6)),
  point("b1", "pdf-2", "paper-b.pdf", 3, "Limitations", "The approach does not generalise to changing log formats over time. ".repeat(6)),
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
