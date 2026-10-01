export const MAX_FILENAME_LENGTH = 180;

// Strip path components, control chars and unsafe symbols; cap length so
// the original name is safe to store/display but never used as a path.
export function sanitizeFilename(name) {
  const base = String(name || "document.pdf").split(/[\\/]/).pop();
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[^a-zA-Z0-9._\-+()\[\] ]/g, "_")
    .trim();
  return (cleaned || "document.pdf").slice(0, MAX_FILENAME_LENGTH);
}

const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF

export function hasPdfMagic(buffer) {
  return !!buffer && buffer.length >= 4 && buffer.subarray(0, 4).equals(PDF_MAGIC);
}
