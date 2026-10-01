/**
 * Shared offline fixtures for the eval harness and unit tests.
 * Synthetic — no infrastructure needed, fully deterministic.
 */

export const FIXTURE_PAGES = [
  "Abstract\n" + "This paper studies retrieval quality for research assistants. ".repeat(8),
  "1. Introduction\n" + "Dense retrieval often misses exact technical terms in queries. ".repeat(10),
  "2. Methods\n" + "We combine dense embeddings with lexical overlap scoring and reranking. ".repeat(12),
  "3. Results\n" + "Hybrid retrieval improves recall at five on the benchmark suite. ".repeat(10),
  "4. Limitations\n" + "The study uses only English corpora and short documents throughout. ".repeat(8),
  "5. Conclusion\n" + "Lexical signals complement embeddings for technical questions. ".repeat(6),
];

function scoredChunk(pdfId, score, text, page = 1, section = "Methods") {
  return { pdfId, pdfTitle: pdfId, fileName: `${pdfId}.pdf`, page, section, text, score };
}

// Retrieval fixture: relevant chunks for "hybrid retrieval" live in pdf-b;
// pdf-a is a distractor with a high dense score but no lexical overlap.
export const RETRIEVAL_FIXTURE = {
  query: "hybrid retrieval with lexical overlap",
  relevantPdfIds: ["pdf-b"],
  candidates: [
    scoredChunk("pdf-a", 0.92, "General discussion of optimisation methods and training loops."),
    scoredChunk("pdf-b", 0.71, "Hybrid retrieval improves recall with lexical overlap scoring."),
    scoredChunk("pdf-b", 0.66, "We combine dense embeddings with lexical reranking methods."),
    scoredChunk("pdf-c", 0.60, "Evaluation uses recall at five and mean reciprocal rank metrics."),
    scoredChunk("pdf-a", 0.55, "Training loops iterate over batches with gradient updates."),
  ],
};

// Classifier battery: [question, expectedType]
export const CLASSIFIER_FIXTURE = [
  ["Compare the methodologies used by these papers", "comparison"],
  ["What are the limitations across these studies?", "limitation"],
  ["What research gaps exist between these studies?", "research-gap"],
  ["Which papers disagree with each other?", "contradiction"],
  ["What dataset did Paper A use?", "methodology"],
  ["What is GRPO?", "definition"],
  ["Summarise the key findings across all papers", "synthesis"],
  ["Which papers use the same dataset?", "methodology"],
  ["Give me evidence with page numbers for this claim", "evidence"],
  ["What methods have not been evaluated against dataset X?", "research-gap"],
  ["Tell me about the results", "factual"],
  ["Survey the landscape of retrieval methods", "exploratory"],
];

// Verification battery: {name, answer, chunks, expectedVerdict}
export const VERIFY_FIXTURE = [
  {
    name: "grounded-cited",
    answer: "Hybrid retrieval improves recall with lexical overlap scoring [1].",
    chunks: [{ text: "Hybrid retrieval improves recall with lexical overlap scoring on benchmarks." }],
    expectedVerdict: "supported",
  },
  {
    name: "hallucinated-invalid-cite",
    answer: "Quantum teleportation enables faster-than-light messaging between GPUs [99].",
    chunks: [{ text: "Hybrid retrieval improves recall with lexical overlap scoring on benchmarks." }],
    expectedVerdict: "needs-review",
  },
  {
    name: "refusal",
    answer: "I couldn't find sufficient evidence in the uploaded papers to answer this reliably.",
    chunks: [{ text: "Anything at all." }],
    expectedVerdict: "refused",
  },
  {
    name: "unanswerable-empty-evidence",
    answer: "The documents were not available at query time.",
    chunks: [],
    expectedVerdict: "needs-review",
  },
];
