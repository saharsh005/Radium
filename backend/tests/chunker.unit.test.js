import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  CHUNK_STRATEGIES,
  getChunkConfig,
  chunkDocument,
  normaliseText,
  buildPageIndex,
  isLikelyHeading,
  isNoiseLine,
} from "../rag/chunker.js";

const SENT = "The proposed method improves retrieval quality on benchmark datasets. ";
function sectionPage(heading, bodyRepeats) {
  // Multiple physical lines per page, like real PDF text extraction.
  const lines = [];
  for (let i = 0; i < bodyRepeats; i += 2) lines.push(SENT.repeat(2).trim());
  return `${heading}\n${lines.join("\n")}`;
}

const PAGES = [
  sectionPage("Abstract", 12),
  sectionPage("1. Introduction", 20),
  sectionPage("2. Methods", 24),
  sectionPage("3. Results", 20),
  sectionPage("4. Conclusion", 10),
];

const OLD_ENV = { ...process.env };
beforeEach(() => {
  delete process.env.CHUNK_STRATEGY;
  delete process.env.CHUNK_TARGET;
  delete process.env.CHUNK_MIN;
  delete process.env.CHUNK_MAX;
  delete process.env.CHUNK_OVERLAP;
});
afterEach(() => {
  for (const k of ["CHUNK_STRATEGY", "CHUNK_TARGET", "CHUNK_MIN", "CHUNK_MAX", "CHUNK_OVERLAP"]) {
    if (OLD_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = OLD_ENV[k];
  }
});

function assertChunkShape(chunks, pageCount) {
  assert.ok(chunks.length > 0, "expected at least one chunk");
  chunks.forEach((c, i) => {
    assert.ok(c.text.length > 0);
    assert.ok(Number.isInteger(c.page) && c.page >= 1 && c.page <= pageCount,
      `chunk ${i} has invalid page ${c.page}`);
    assert.equal(c.chunkIndex, i);
    assert.ok(typeof c.section === "string" && c.section.length > 0);
  });
}

describe("getChunkConfig", () => {
  it("defaults to section-aware with sane sizes", () => {
    const cfg = getChunkConfig();
    assert.equal(cfg.strategy, "section-aware");
    assert.deepEqual([cfg.target, cfg.min, cfg.max, cfg.overlap], [800, 250, 1100, 150]);
  });

  it("honours env overrides and rejects unknown strategies", () => {
    process.env.CHUNK_STRATEGY = "bogus";
    process.env.CHUNK_TARGET = "400";
    const cfg = getChunkConfig();
    assert.equal(cfg.strategy, "section-aware");
    assert.equal(cfg.target, 400);
    process.env.CHUNK_STRATEGY = "fixed";
    assert.equal(getChunkConfig().strategy, "fixed");
  });

  it("exposes exactly the four documented strategies", () => {
    assert.deepEqual([...CHUNK_STRATEGIES].sort(), ["fixed", "paragraph", "recursive", "section-aware"]);
  });
});

describe("chunkDocument strategies", () => {
  for (const strategy of CHUNK_STRATEGIES) {
    it(`${strategy}: produces well-formed chunks with real pages`, () => {
      const { chunks, strategy: used } = chunkDocument(PAGES, { strategy });
      assert.equal(used, strategy);
      assertChunkShape(chunks, PAGES.length);
    });

    it(`${strategy}: is deterministic`, () => {
      const a = chunkDocument(PAGES, { strategy });
      const b = chunkDocument(PAGES, { strategy });
      assert.deepEqual(a.chunks, b.chunks);
    });
  }

  it("section-aware: keeps section names from headings", () => {
    const { chunks } = chunkDocument(PAGES, { strategy: "section-aware" });
    assert.ok(chunks.some((c) => /introduction/i.test(c.section)),
      "expected a chunk attributed to Introduction");
  });

  it("paragraph: attributes chunks per page", () => {
    const { chunks } = chunkDocument(PAGES, { strategy: "paragraph" });
    const pages = new Set(chunks.map((c) => c.page));
    assert.ok(pages.size >= 3, `expected multi-page coverage, got ${[...pages]}`);
  });

  it("fixed: respects target size bound", () => {
    const { chunks } = chunkDocument(PAGES, { strategy: "fixed", target: 500, min: 50, overlap: 50 });
    for (const c of chunks.slice(0, -1)) {
      assert.ok(c.text.length <= 500, `chunk exceeds target: ${c.text.length}`);
    }
  });

  it("empty input yields no chunks without throwing", () => {
    for (const strategy of CHUNK_STRATEGIES) {
      const { chunks } = chunkDocument([], { strategy });
      assert.deepEqual(chunks, []);
    }
  });
});

describe("text helpers", () => {
  it("normaliseText collapses whitespace and de-hyphenates", () => {
    assert.equal(normaliseText("a  b\tc\n\n\nretri-\neval"), "a b c\n\nretrieval");
  });

  it("buildPageIndex maps offsets to pages", () => {
    const { fullText, pageAtOffset } = buildPageIndex(["aa", "bb", "cc"]);
    assert.equal(pageAtOffset(0), 1);
    assert.equal(pageAtOffset(fullText.indexOf("bb")), 2);
    assert.equal(pageAtOffset(fullText.length - 1), 3);
  });

  it("heading/noise detectors behave", () => {
    assert.equal(isLikelyHeading("2. Methods"), true);
    assert.equal(isLikelyHeading("This is a normal sentence, with a comma."), false);
    assert.equal(isNoiseLine("123"), true);
    assert.equal(isNoiseLine("A real content line with words"), false);
  });
});
