import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

// The PDF worker must run as an INDEPENDENT process (`npm run worker`),
// not inside the API process. Auto-starting it here causes double
// processing when both `npm start` and the worker run (duplicate Qdrant
// points, duplicate gap generation). Opt-in only for single-process dev:
//   RADIUM_RUN_WORKER=true node server.js
if (process.env.RADIUM_RUN_WORKER === "true") {
  await import("./queue/worker.js");
}

import express from "express";
import cors from "cors";
import Redis from "ioredis";

import { supabase } from "./utils/supabase.js";
import { createQdrantClient } from "./utils/qdrant.js";
import { getRedisOptions } from "./queue/pdfQueue.js";

const app = express();

app.use(express.json());
app.use(cors({
  origin: [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://radium-tan.vercel.app"
  ],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
}));

// Routes
import upload from "./routes/upload.js";
import chat from "./routes/chat.js";
import pdfRoutes from "./routes/pdf.js";
import workspaceRoutes from "./routes/workspace.js";
import evalRoutes from "./routes/eval.js";
import { readLimiter, writeLimiter } from "./middleware/rateLimit.js";

app.use("/workspace", readLimiter, workspaceRoutes);
app.use("/pdf", readLimiter, pdfRoutes);
// LLM + upload endpoints are costly/abuse-prone → strict limits.
app.use("/chat", writeLimiter, chat);
// NOTE: clerkAuth lives on the upload route itself; do not add it here
// a second time.
app.use("/upload", writeLimiter, upload);
app.use("/eval", readLimiter, evalRoutes);

app.get("/health", (req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

// Readiness: checks each external dependency with a short timeout.
// Never throws, never leaks credentials — only ok/latency/message.
async function checkWithTimeout(name, fn, timeoutMs = 5000) {
  const started = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err?.message ?? "unknown error" };
  }
}

app.get("/health/ready", async (req, res) => {
  const [supabaseCheck, qdrantCheck, redisCheck] = await Promise.all([
    checkWithTimeout("supabase", async () => {
      const { error } = await supabase.from("workspaces").select("id").limit(1);
      if (error) throw error;
    }),
    checkWithTimeout("qdrant", async () => {
      await createQdrantClient({ timeout: 5000 }).getCollections();
    }),
    checkWithTimeout("redis", async () => {
      const client = new Redis({ ...getRedisOptions(), lazyConnect: true, enableReadyCheck: false, maxRetriesPerRequest: 1 });
      try {
        await client.ping();
      } finally {
        client.disconnect();
      }
    }),
  ]);

  const checks = { supabase: supabaseCheck, qdrant: qdrantCheck, redis: redisCheck };
  const ready = Object.values(checks).every((c) => c.ok);
  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "degraded",
    checks,
    timestamp: new Date().toISOString(),
  });
});
app.get("/", (req, res) => res.json({ status: "Radium backend running 🚀" }));

app.use((err, req, res, next) => {
  console.error("Global error:", err.message, err);
  // Handle Clerk auth errors
  if (err.message?.includes("Unauthenticated")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
});



const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
