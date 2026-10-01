import { v5 as uuidv5 } from "uuid";

// Fixed namespace for deterministic v5 UUIDs (generated once, never changes).
const CHUNK_NAMESPACE = "8f6b2c1a-4e3d-4f7a-9b1c-2d3e4f5a6b7c";

// Deterministic Qdrant point ID for a chunk. Re-indexing the same PDF
// upserts the same point IDs instead of creating duplicates, and BullMQ
// retries of a failed batch are idempotent.
export function deterministicChunkId(workspaceId, pdfId, chunkIndex) {
  return uuidv5(`${workspaceId}:${pdfId}:${chunkIndex}`, CHUNK_NAMESPACE);
}
