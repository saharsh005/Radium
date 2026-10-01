import express from "express";
import multer from 'multer';
import { randomUUID } from "crypto";
import { v4 as uuidv4 } from 'uuid';
import { clerkAuth } from "../middleware/auth.js";
import { pdfQueue } from "../queue/pdfQueue.js";
import { supabase } from "../utils/supabase.js";
import { sanitizeFilename, hasPdfMagic } from "../utils/filenames.js";


const router = express.Router();

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_BYTES
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Only PDFs allowed"));
    }
    cb(null, true);
  }
});


router.post("/", clerkAuth, upload.single("pdf"), async (req, res) => {
  const requestId = randomUUID();
  const log = (stage, extra) =>
    console.log(`[upload:${requestId}] ${stage}`, extra ?? "");

  try {
    const { userId } = req.auth;
    const { workspaceId } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId is required" });
    }

    // Validate PDF magic bytes — mimetype alone is spoofable.
    if (!hasPdfMagic(file.buffer)) {
      log("rejected-not-a-pdf");
      return res.status(400).json({ error: "File is not a valid PDF" });
    }

    // Verify the authenticated user owns the workspace before touching
    // storage or the database.
    const { data: workspace, error: wsError } = await supabase
      .from("workspaces")
      .select("id")
      .eq("id", workspaceId)
      .eq("clerk_id", userId)
      .single();

    if (wsError || !workspace) {
      log("rejected-workspace-forbidden");
      return res.status(403).json({ error: "Workspace not found or access denied" });
    }

    const safeName = sanitizeFilename(file.originalname);
    const pdfId = `${userId}_${uuidv4()}`;
    const storagePath = `${userId}/${pdfId}.pdf`;

    // Duplicate guard: same user + workspace + filename already recorded.
    const { data: existing } = await supabase
      .from("user_pdfs")
      .select("pdf_id")
      .eq("workspace_id", workspaceId)
      .eq("clerk_id", userId)
      .eq("filename", safeName)
      .limit(1);
    if (existing && existing.length > 0) {
      log("rejected-duplicate", { filename: safeName });
      return res.status(409).json({
        error: "This file was already uploaded to this workspace",
        pdfId: existing[0].pdf_id,
      });
    }

    // 1. Upload to Supabase storage
    log("storage-upload-start", { bytes: file.buffer.length });
    const { error: storageError } = await supabase.storage
      .from("pdfs")
      .upload(storagePath, file.buffer, {
        contentType: "application/pdf"
      });

    if (storageError) {
      log("storage-upload-failed", { message: storageError.message });
      return res.status(502).json({ error: "File storage failed, please retry" });
    }
    log("storage-upload-ok");

    // 2. Ensure user exists
    const { error: userError } = await supabase
      .from("users")
      .upsert(
        { clerk_id: userId },
        { onConflict: "clerk_id" }
      );
    if (userError) {
      // No DB row created yet — remove the orphaned object.
      await supabase.storage.from("pdfs").remove([storagePath]);
      log("user-upsert-failed", { message: userError.message });
      return res.status(500).json({ error: "Upload failed, please retry" });
    }

    // 3. Store PDF metadata WITH workspace_id. If this fails, remove the
    // uploaded object so no orphaned file is left behind.
    // The `status` column needs migration 001; retry without it on older schemas.
    const metadataRow = {
      pdf_id: pdfId,
      clerk_id: userId,
      workspace_id: workspaceId,
      filename: safeName,
      storage_path: storagePath,
      status: "QUEUED",
    };
    let { error: dbError } = await supabase.from("user_pdfs").insert(metadataRow);
    if (dbError && /column|status/i.test(dbError.message ?? "")) {
      const { status: _dropped, ...legacyRow } = metadataRow;
      ({ error: dbError } = await supabase.from("user_pdfs").insert(legacyRow));
    }

    if (dbError) {
      await supabase.storage.from("pdfs").remove([storagePath]);
      log("metadata-insert-failed", { message: dbError.message });
      return res.status(500).json({ error: "Upload failed, please retry" });
    }
    log("metadata-insert-ok", { pdfId });

    // 4. Enqueue indexing job WITH workspaceId. Retries with exponential
    // backoff; if enqueue fails, roll back DB row + object so a retry of
    // the whole upload is safe and no phantom "uploaded" row remains.
    try {
      await pdfQueue.add("process-pdf", {
        pdfId,
        storagePath,
        userId,
        workspaceId
      }, {
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      });
    } catch (queueError) {
      await supabase.from("user_pdfs").delete().eq("pdf_id", pdfId);
      await supabase.storage.from("pdfs").remove([storagePath]);
      log("enqueue-failed-rolled-back", { message: queueError.message });
      return res.status(503).json({ error: "Indexing queue unavailable, please retry" });
    }
    log("enqueue-ok");

    res.json({
      message: "Upload successful, processing started",
      pdfId,
      status: "QUEUED",
    });

  } catch (err) {
    console.error(`[upload:${requestId}] unexpected error:`, err);
    res.status(500).json({ error: "Upload failed" });
  }
});



export default router;
