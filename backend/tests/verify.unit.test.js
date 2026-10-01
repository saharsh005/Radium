import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractClaims,
  validateCitations,
  claimChunkScore,
  verifyAnswer,
  isRefusalAnswer,
} from "../rag/verify.js";

const CHUNKS = [
  { text: "InstructGPT uses PPO for fine-tuning with human feedback and a critic network." },
  { text: "DeepSeek-R1 uses GRPO which removes the need for a critic network." },
];

describe("extractClaims", () => {
  it("splits sentences and strips markdown structure", () => {
    const claims = extractClaims("## Answer\n- InstructGPT uses PPO [1].\n- DeepSeek uses GRPO [2].");
    assert.equal(claims.length, 2);
    assert.ok(claims[0].includes("InstructGPT"));
  });

  it("drops questions and refusal boilerplate", () => {
    const claims = extractClaims("What is PPO? The provided documents do not contain enough information about X.");
    assert.deepEqual(claims, []);
  });

  it("handles empty input", () => {
    assert.deepEqual(extractClaims(""), []);
    assert.deepEqual(extractClaims(null), []);
  });
});

describe("validateCitations", () => {
  it("accepts in-range citations and flags invented numbers", () => {
    assert.deepEqual(validateCitations("A [1] and B [2].", 2), { used: [1, 2], invalid: [], valid: true });
    const bad = validateCitations("A [1] and B [99].", 2);
    assert.deepEqual(bad.invalid, [99]);
    assert.equal(bad.valid, false);
  });
});

describe("claimChunkScore", () => {
  it("scores token recall against chunk text", () => {
    assert.equal(claimChunkScore("", "anything"), 0);
    const s = claimChunkScore("DeepSeek-R1 uses GRPO without a critic network", CHUNKS[1].text);
    assert.ok(s > 0.4, `expected high recall, got ${s}`);
    const low = claimChunkScore("Quantum entanglement enables teleportation protocols", CHUNKS[0].text);
    assert.ok(low < 0.15, `expected low recall, got ${low}`);
  });
});

describe("verifyAnswer", () => {
  it("marks grounded cited answers as supported", () => {
    const report = verifyAnswer(
      "InstructGPT uses PPO for fine-tuning with human feedback [1]. DeepSeek-R1 uses GRPO without a critic network [2].",
      CHUNKS
    );
    assert.equal(report.verdict, "supported");
    assert.equal(report.citationCoverage, 1);
    assert.deepEqual(report.invalidCitations, []);
  });

  it("flags hallucinated claims and invented citations", () => {
    const report = verifyAnswer(
      "Quantum teleportation enables faster-than-light messaging between GPUs [99].",
      CHUNKS
    );
    assert.equal(report.verdict, "needs-review");
    assert.deepEqual(report.invalidCitations, [99]);
    assert.equal(report.claims[0].status, "unsupported");
  });

  it("detects miscited claims (right info, wrong pointer)", () => {
    const chunks = [
      { text: "We tune learning rate schedules and batch sizes for stable optimisation." },
      { text: "DeepSeek-R1 uses GRPO which removes the need for a critic network." },
    ];
    const report = verifyAnswer("DeepSeek-R1 uses GRPO without a critic network [1].", chunks);
    assert.equal(report.claims[0].status, "miscited");
  });

  it("detects supported-but-uncited claims", () => {
    const report = verifyAnswer("DeepSeek-R1 uses GRPO without a critic network.", CHUNKS);
    assert.equal(report.claims[0].status, "supported-uncited");
    assert.equal(report.citationCoverage, 0);
  });

  it("short-circuits refusals", () => {
    const report = verifyAnswer(
      "I couldn't find sufficient evidence in the uploaded papers to answer this reliably.",
      CHUNKS
    );
    assert.equal(report.verdict, "refused");
  });

  it("is deterministic", () => {
    const a = "InstructGPT uses PPO for fine-tuning with human feedback [1].";
    assert.deepEqual(verifyAnswer(a, CHUNKS), verifyAnswer(a, CHUNKS));
  });
});

describe("isRefusalAnswer", () => {
  it("recognises refusal phrasing", () => {
    assert.equal(isRefusalAnswer("I couldn't find sufficient evidence in the uploaded papers."), true);
    assert.equal(isRefusalAnswer("PPO is great."), false);
  });
});
