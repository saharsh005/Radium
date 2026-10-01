import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  diversifyChunks,
  rerankChunks,
  buildContext,
  buildSources,
  classifyQuery,
  getRetrievalPlan,
} from "../rag/retriever.js";

function chunk(overrides = {}) {
  return {
    pdfId: "pdf-a",
    pdfTitle: "Paper A",
    fileName: "a.pdf",
    page: 1,
    section: "Introduction",
    text: "Some research content about transformers.",
    score: 0.8,
    ...overrides,
  };
}

describe("diversifyChunks", () => {
  it("guarantees one chunk per document before filling by score", () => {
    const chunks = [
      chunk({ pdfId: "pdf-a", score: 0.9, text: "alpha content one two three" }),
      chunk({ pdfId: "pdf-a", score: 0.85, text: "beta content four five six" }),
      chunk({ pdfId: "pdf-b", score: 0.5, text: "gamma content seven eight nine" }),
    ];
    const out = diversifyChunks(chunks, 2);
    assert.equal(out.length, 2);
    const ids = new Set(out.map((c) => c.pdfId));
    assert.ok(ids.has("pdf-a") && ids.has("pdf-b"));
  });

  it("deduplicates near-identical chunks", () => {
    const chunks = [
      chunk({ score: 0.9, text: "x".repeat(200) }),
      chunk({ score: 0.8, text: "x".repeat(200) }),
    ];
    const out = diversifyChunks(chunks, 5);
    assert.equal(out.length, 1);
  });

  it("caps output at maxTotal", () => {
    const chunks = Array.from({ length: 10 }, (_, i) =>
      chunk({ pdfId: `pdf-${i}`, score: 0.9 - i * 0.01, text: `unique text block number ${i} pad pad pad` })
    );
    assert.equal(diversifyChunks(chunks, 4).length, 4);
  });
});

describe("rerankChunks", () => {
  it("boosts chunks with exact query-term overlap when scores are close", () => {
    const chunks = [
      chunk({ score: 0.7, text: "general discussion of optimisation methods" }),
      chunk({ score: 0.65, text: "we evaluate GRPO against PPO baselines" }),
    ];
    const out = rerankChunks("GRPO versus PPO comparison", chunks);
    assert.equal(out[0].text.includes("GRPO"), true);
  });

  it("returns input unchanged when no keywords survive filtering", () => {
    const chunks = [chunk(), chunk()];
    assert.deepEqual(rerankChunks("a an of", chunks), chunks);
  });
});

describe("buildContext / buildSources", () => {
  it("numbers citations 1..n and keeps provenance fields", () => {
    const chunks = [
      chunk({ page: 4, section: "Methods" }),
      chunk({ pdfId: "pdf-b", pdfTitle: "Paper B", fileName: "b.pdf", page: 8, section: "Results" }),
    ];
    const { context, citations } = buildContext(chunks);
    assert.equal(citations.length, 2);
    assert.deepEqual(citations.map((c) => c.index), [1, 2]);
    assert.equal(citations[0].page, 4);
    assert.equal(citations[1].pdfId, "pdf-b");
    assert.ok(context.includes("[1]") && context.includes("[2]"));
    // No fabricated page numbers beyond what chunks carry
    assert.ok(context.includes("Page: 4") && context.includes("Page: 8"));
  });

  it("dedupes sources by (pdfId, page, section) and caps at 8", () => {
    const chunks = Array.from({ length: 10 }, (_, i) =>
      chunk({ page: i + 1, section: "S", text: `evidence text ${i} ${"z".repeat(160)}` })
    );
    const { citations } = buildContext(chunks);
    const sources = buildSources(chunks, citations);
    assert.equal(sources.length, 8);
    assert.ok(sources.every((s) => typeof s.citationIndex === "number"));
  });

  it("handles empty input without throwing", () => {
    const { context, citations } = buildContext([]);
    assert.equal(context, "");
    assert.deepEqual(citations, []);
    assert.deepEqual(buildSources([], []), []);
  });
});

describe("classifyQuery", () => {
  const cases = [
    ["Compare the methodologies used by these papers", "comparison"],
    ["What are the limitations across these studies?", "limitation"],
    ["What research gaps exist between these studies?", "research-gap"],
    ["Which papers disagree with each other?", "contradiction"],
    ["What dataset did Paper A use?", "methodology"],
    ["What is GRPO?", "definition"],
    ["Summarise the key findings across all papers", "synthesis"],
    ["Which papers use the same dataset?", "methodology"],
    ["Which papers are included in this workspace?", "multi-paper"],
    ["Give me evidence with page numbers for this claim", "evidence"],
    ["What methods have not been evaluated against dataset X?", "research-gap"],
  ];
  for (const [question, expected] of cases) {
    it(`classifies "${question.slice(0, 40)}…" as ${expected}`, () => {
      assert.equal(classifyQuery(question).type, expected);
    });
  }

  it("defaults to factual with low confidence on plain questions", () => {
    const out = classifyQuery("Tell me about the results");
    assert.equal(out.type, "factual");
    assert.ok(out.confidence < 0.5);
    assert.equal(out.multiDoc, false);
  });

  it("marks multi-document intents", () => {
    assert.equal(classifyQuery("Compare PPO and GRPO").multiDoc, true);
    assert.equal(classifyQuery("What is PPO?").multiDoc, false);
    // Cross-paper scope is a modifier: content type wins, scope widens.
    const scoped = classifyQuery("What are the limitations across these studies?");
    assert.equal(scoped.type, "limitation");
    assert.equal(scoped.multiDoc, true);
  });
});

describe("getRetrievalPlan", () => {
  it("casts a wider net for multi-document intents", () => {
    const broad = getRetrievalPlan("comparison");
    const narrow = getRetrievalPlan("factual");
    assert.ok(broad.topK > narrow.topK);
    assert.ok(broad.scoreThreshold < narrow.scoreThreshold);
    assert.ok(broad.diversifyK >= narrow.diversifyK);
  });

  it("widens scope for cross-paper modifiers even on narrow types", () => {
    assert.deepEqual(
      getRetrievalPlan("methodology", true),
      getRetrievalPlan("comparison")
    );
    assert.deepEqual(
      getRetrievalPlan("factual", true).topK,
      getRetrievalPlan("multi-paper").topK
    );
  });

  it("falls back to the narrow plan for unknown types", () => {
    assert.deepEqual(getRetrievalPlan("something-new"), getRetrievalPlan("factual"));
  });
});
