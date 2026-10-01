/**
 * Radium chunking strategies.
 *
 * The strategy is selected with CHUNK_STRATEGY (default: "section-aware")
 * so chunking variants can be compared in evaluation instead of being
 * hardcoded. Sizes are configurable via CHUNK_TARGET / CHUNK_MIN /
 * CHUNK_MAX / CHUNK_OVERLAP (character counts).
 *
 * Every strategy receives normalised per-page texts and returns chunks
 * with REAL page numbers — no estimates.
 */

export const CHUNK_STRATEGIES = ["section-aware", "paragraph", "fixed", "recursive"];

export function getChunkConfig(overrides = {}) {
  const num = (v, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    strategy: CHUNK_STRATEGIES.includes(process.env.CHUNK_STRATEGY)
      ? process.env.CHUNK_STRATEGY
      : "section-aware",
    target:  num(process.env.CHUNK_TARGET, 800),
    min:     num(process.env.CHUNK_MIN, 250),
    max:     num(process.env.CHUNK_MAX, 1100),
    overlap: num(process.env.CHUNK_OVERLAP, 150),
    ...overrides,
  };
}

// ─── Noise line detector ──────────────────────────────────
const NOISE_PATTERNS = [
  /IJISS\s+Vol\.\s*\d+/i,
  /^Vol\.\s*\d+\s+No\.\s*\d+/i,
  /^Page\s+\d+\s*$/i,
  /^October|^November|^December|^January/i,
  /^\s*\d+\s*$/,
  /^[=+\-*/<>\[\]{}()×÷±∞\d\s.,;:]+$/,
  /[∑∫∂∇≠≤≥√πμστφθλρψωαβγδεζη×÷±∞]{2,}/,
  /^https?:\/\//i,
  /^doi:/i,
  /^\[?\d+\]?\s+[A-Z][a-z]+.*\d{4}[.,]/,
];

export function isNoiseLine(line) {
  const t = line.trim();
  if (t.length === 0) return true;
  return NOISE_PATTERNS.some((re) => re.test(t));
}

// ─── Section Heading Detector ─────────────────────────────
export function isLikelyHeading(line) {
  const t = line.trim();
  if (t.length < 4 || t.length > 60)  return false;
  if (isNoiseLine(t))                  return false;
  if (/[∑∫∂∇≠≤≥√πμστφθλρψωαβγδεζη×÷±∞]/.test(t)) return false;
  if (/[,;]\s/.test(t))                return false;

  if (/^(X{0,3})(IX|IV|V?I{0,3})\.\s+[A-Z][a-zA-Z\s\-]{2,}$/.test(t)) return true;
  if (/^\d+(\.\d+)*\.?\s+[A-Z][a-zA-Z\s\-]{2,}$/.test(t))              return true;

  if (/^[A-Z][A-Z\s\-]{3,}$/.test(t)) {
    const wc = t.trim().split(/\s+/).length;
    if (wc === 1 && t.length < 5) return false;
    if (wc > 7)                   return false;
    return true;
  }
  return false;
}

// ─── Text Normaliser ──────────────────────────────────────
export function normaliseText(raw) {
  return raw
    .replace(/IJISS\s+Vol\.\s*\d+\s+No\.\s*\d+[^\n]*/gi, "")
    .replace(/(\w)-\n(\w)/g, "$1$2")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Page index ───────────────────────────────────────────
/**
 * Join pages into one text while remembering which page each character
 * offset belongs to. Strategies that cut across page boundaries use
 * pageAtOffset() so no chunk gets an estimated page.
 */
export function buildPageIndex(pages) {
  const pageStarts = [];
  let fullText = "";
  pages.forEach((pageText, i) => {
    pageStarts.push(fullText.length);
    fullText += (i > 0 ? "\n\n" : "") + pageText;
  });
  return {
    fullText,
    pageAtOffset(offset) {
      let page = 1;
      for (let i = 0; i < pageStarts.length; i++) {
        if (offset >= pageStarts[i]) page = i + 1;
        else break;
      }
      return page;
    },
  };
}

// ─── Sentence splitter (shared by section-aware + recursive) ──
export function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
}

// Accumulate sentences into target-sized chunks with overlap carry.
export function packSentences(sentences, { target, min, max, overlap }) {
  const chunks = [];
  let current  = "";
  let carry    = "";

  for (const sentence of sentences) {
    if (current.length > 0 && current.length + sentence.length > max) {
      if (current.length >= min) chunks.push(current.trim());
      carry   = current.slice(-overlap).trim();
      current = carry ? carry + " " + sentence : sentence;
    } else {
      current += (current ? " " : "") + sentence;
      if (current.length >= target) {
        if (current.length >= min) chunks.push(current.trim());
        carry   = current.slice(-overlap).trim();
        current = "";
      }
    }
  }
  if (current.trim().length >= min) chunks.push(current.trim());
  return chunks;
}

// ─── Section detection (section-aware strategy) ───────────
function detectSections(pages) {
  const lines = [];
  const linePages = [];
  pages.forEach((pageText, pageIdx) => {
    for (const raw of pageText.split("\n")) {
      const t = raw.trim();
      if (!t) continue;
      lines.push(t);
      linePages.push(pageIdx + 1);
    }
  });

  const sections = [];
  let current    = { title: "Preamble", lines: [], lineStart: 0 };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isLikelyHeading(line)) {
      if (current.lines.length > 3) {
        sections.push({ ...current, lineEnd: i, page: linePages[current.lineStart] ?? 1 });
      }
      current = { title: line, lines: [], lineStart: i };
    } else if (!isNoiseLine(line) && line.length > 15) {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 3) {
    sections.push({ ...current, lineEnd: lines.length, page: linePages[current.lineStart] ?? 1 });
  }
  return sections.filter((s) => s.lines.length > 5);
}

function sectionAwareChunks(pages, config) {
  let sections = detectSections(pages);
  if (sections.length < 3) {
    // Paragraph fallback keeps real pages (one bucket set per page).
    sections = [];
    pages.forEach((pageText, pageIdx) => {
      const page = pageIdx + 1;
      const paragraphs = pageText
        .split(/\n+/)
        .map((p) => p.replace(/\s+/g, " ").trim())
        .filter((p) => p.length > 80 && !isNoiseLine(p));
      let bucket = [], bucketLen = 0, seg = 1;
      const flush = () => {
        if (bucket.length > 0) {
          sections.push({ title: `Page ${page} · Segment ${seg++}`, lines: bucket, page });
          bucket = []; bucketLen = 0;
        }
      };
      for (const para of paragraphs) {
        if (bucketLen + para.length > 1200 && bucket.length > 0) flush();
        bucket.push(para);
        bucketLen += para.length;
      }
      flush();
    });
  }

  const chunks = [];
  for (const section of sections) {
    const sectionText = section.lines.join(" ").replace(/\s+/g, " ").trim();
    if (sectionText.length < 80) continue;
    for (const text of packSentences(splitSentences(sectionText), config)) {
      chunks.push({ text, page: section.page ?? 1, section: section.title.substring(0, 120) });
    }
  }
  return chunks;
}

function paragraphChunks(pages, config) {
  const chunks = [];
  pages.forEach((pageText, pageIdx) => {
    const page = pageIdx + 1;
    const paragraphs = pageText
      .split(/\n+/)
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter((p) => p.length > 40 && !isNoiseLine(p));
    let current = "";
    const flush = () => {
      if (current.trim().length >= config.min) {
        chunks.push({ text: current.trim(), page, section: `Page ${page}` });
      }
      current = "";
    };
    for (const para of paragraphs) {
      if (current.length > 0 && current.length + para.length > config.max) flush();
      current += (current ? " " : "") + para;
      if (current.length >= config.target) flush();
    }
    flush();
  });
  return chunks;
}

function fixedChunks(pages, config) {
  const { fullText, pageAtOffset } = buildPageIndex(pages);
  const size = config.target;
  const step = Math.max(1, size - config.overlap);
  const chunks = [];
  for (let start = 0; start < fullText.length; start += step) {
    const text = fullText.slice(start, start + size).replace(/\s+/g, " ").trim();
    if (text.length < config.min && start + size < fullText.length) continue;
    if (text.length === 0) break;
    chunks.push({ text, page: pageAtOffset(start), section: `Page ${pageAtOffset(start)}` });
    if (start + size >= fullText.length) break;
  }
  return chunks;
}

function recursiveChunks(pages, config) {
  const { fullText, pageAtOffset } = buildPageIndex(pages);
  // Sentence-first packing with character offsets tracked, so page
  // attribution stays exact even without section awareness. (Ablation
  // baseline vs section-aware.)
  const sentences = splitSentences(fullText);
  const chunks = [];
  let current = "", currentStart = 0, cursor = 0;

  const flush = () => {
    if (current.trim().length >= config.min) {
      chunks.push({ text: current.trim(), page: pageAtOffset(currentStart), section: "Full text" });
    }
    // Overlap carry, mirroring packSentences.
    const carry = current.slice(-config.overlap).trim();
    current = "";
    return carry;
  };

  let carry = "";
  for (const s of sentences) {
    const idx = fullText.indexOf(s, cursor);
    const at = idx >= 0 ? idx : cursor;
    if (!current) {
      currentStart = at;
      current = carry ? carry + " " + s : s;
      carry = "";
    } else if (current.length + s.length > config.max) {
      carry = flush();
      currentStart = at;
      current = carry ? carry + " " + s : s;
      carry = "";
    } else {
      current += " " + s;
      if (current.length >= config.target) carry = flush();
    }
    cursor = at + s.length;
  }
  if (current.trim().length >= config.min) {
    chunks.push({ text: current.trim(), page: pageAtOffset(currentStart), section: "Full text" });
  }
  return chunks;
}

// ─── Registry entry point ─────────────────────────────────
/**
 * @param {string[]} pages  Normalised per-page texts (pages[i] = page i+1)
 * @param {object} [overrides]  Partial chunk config (strategy, target, min, max, overlap)
 * @returns {{ chunks: Array<{text,page,section,chunkIndex}>, strategy: string }}
 */
export function chunkDocument(pages, overrides = {}) {
  const config = getChunkConfig(overrides);
  let raw;
  switch (config.strategy) {
    case "paragraph": raw = paragraphChunks(pages, config); break;
    case "fixed":     raw = fixedChunks(pages, config); break;
    case "recursive": raw = recursiveChunks(pages, config); break;
    case "section-aware":
    default:          raw = sectionAwareChunks(pages, config); break;
  }
  const chunks = raw.map((c, chunkIndex) => ({ ...c, chunkIndex }));
  return { chunks, strategy: config.strategy };
}
