import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeFilename, hasPdfMagic } from "../utils/filenames.js";
import { deterministicChunkId } from "../utils/ids.js";

describe("sanitizeFilename", () => {
  it("strips directory traversal components", () => {
    assert.equal(sanitizeFilename("../../etc/passwd.pdf"), "passwd.pdf");
    assert.equal(sanitizeFilename("C:\\temp\\evil.pdf"), "evil.pdf");
  });

  it("replaces unsafe characters and caps length", () => {
    assert.equal(sanitizeFilename("my paper: v2/final?.pdf"), "final_.pdf");
    assert.equal(sanitizeFilename("report: v2.pdf"), "report_ v2.pdf");
    assert.ok(sanitizeFilename("a".repeat(500)).length <= 180);
  });

  it("falls back for empty input", () => {
    assert.equal(sanitizeFilename(""), "document.pdf");
    assert.equal(sanitizeFilename(null), "document.pdf");
  });
});

describe("hasPdfMagic", () => {
  it("accepts %PDF headers and rejects anything else", () => {
    assert.equal(hasPdfMagic(Buffer.from("%PDF-1.7 rest of file")), true);
    assert.equal(hasPdfMagic(Buffer.from([0x25, 0x50, 0x44, 0x46])), true);
    assert.equal(hasPdfMagic(Buffer.from("MZ fake exe")), false);
    assert.equal(hasPdfMagic(null), false);
    assert.equal(hasPdfMagic(Buffer.alloc(0)), false);
  });
});

describe("deterministicChunkId", () => {
  it("is stable for the same inputs and unique across chunks", () => {
    const a = deterministicChunkId("ws1", "pdf1", 0);
    assert.equal(a, deterministicChunkId("ws1", "pdf1", 0));
    assert.notEqual(a, deterministicChunkId("ws1", "pdf1", 1));
    assert.notEqual(a, deterministicChunkId("ws2", "pdf1", 0));
    // Valid UUID format (Qdrant accepts UUID string point IDs)
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
