import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  questionKeywords,
  extractWorkspaceConcepts,
  buildSearchQueries,
  scorePaper,
  rankPapers,
  dedupePapers,
} from "../rag/internet.js";

const CHUNKS = [
  { payload: { text: "Transformer models for log anomaly detection with parsing. ".repeat(10) } },
  { payload: { text: "Log anomaly detection benchmarks on HDFS and BGL datasets. ".repeat(10) } },
  { payload: { text: "Unrelated baking recipes with flour and sugar content here. ".repeat(10) } },
];

describe("questionKeywords", () => {
  it("extracts ordered content terms, dropping stopwords", () => {
    assert.deepEqual(
      questionKeywords("What methods exist for log anomaly detection?"),
      ["methods", "exist", "anomaly", "detection"]
    );
  });
});

describe("extractWorkspaceConcepts", () => {
  it("ranks cross-chunk vocabulary first", () => {
    const concepts = extractWorkspaceConcepts(CHUNKS, 5);
    const terms = concepts.map((c) => c.term);
    // "anomaly"/"detection" appear in 2 chunks; "flour" only in 1.
    assert.ok(terms.includes("anomaly") || terms.includes("detection"));
    assert.ok(!terms.slice(0, 2).includes("flour"));
    assert.ok(concepts[0].chunks >= concepts[concepts.length - 1].chunks);
  });

  it("handles empty input", () => {
    assert.deepEqual(extractWorkspaceConcepts([]), []);
  });
});

describe("buildSearchQueries", () => {
  it("builds question-led, workspace-led and mixed queries", () => {
    const concepts = [{ term: "transformer" }, { term: "hdfs" }];
    const qs = buildSearchQueries("log anomaly detection methods", concepts, 3);
    assert.equal(qs.length, 3);
    assert.ok(qs[0].includes("anomaly"));
    assert.ok(qs[1].includes("transformer"));
    assert.ok(qs.every((q) => q.length > 0));
  });

  it("drops blanks and duplicates", () => {
    assert.deepEqual(buildSearchQueries("", [], 3), []);
  });
});

describe("scorePaper / rankPapers", () => {
  const papers = [
    { title: "Baking bread at home", abstract: "Flour, water and patience." },
    { title: "Log anomaly detection with transformers", abstract: "HDFS benchmark evaluation." },
  ];

  it("scores topical papers higher and tags provenance", () => {
    const ranked = rankPapers(papers, ["anomaly", "detection", "transformers"]);
    assert.equal(ranked[0].title.includes("anomaly"), true);
    assert.ok(ranked[0].relevance > ranked[1].relevance);
    assert.ok(ranked.every((p) => p.origin === "EXTERNAL"));
  });

  it("returns 0 with no query terms", () => {
    assert.equal(scorePaper(papers[0], []), 0);
  });
});

describe("dedupePapers", () => {
  it("dedupes by DOI then title, dropping untitled", () => {
    const papers = [
      { title: "A", doi: "10.1/x" },
      { title: "A (preprint)", doi: "10.1/X" },
      { title: "A (preprint)" },
      { title: "" },
    ];
    const out = dedupePapers(papers);
    assert.equal(out.length, 2);
  });
});
