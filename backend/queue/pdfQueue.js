import { Queue, QueueEvents } from "bullmq";
import { createRedisConnection } from "./redisConnection.js";

// Shared Redis options (supports REDIS_URL / rediss TLS for Upstash).
// maxRetriesPerRequest must stay null for BullMQ's blocking commands.
export function getRedisOptions() {
  return createRedisConnection();
}

export const pdfQueue = new Queue("pdf-queue", {
  connection: getRedisOptions(),
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

// Never crash the API process on Redis connection errors — log them.
// (Without this listener, an 'error' event on the Queue EventEmitter
// would throw and take down the server when Redis is unreachable.)
pdfQueue.on("error", (err) => {
  console.error("PDF queue connection error:", err?.message ?? err);
});

// Singleton QueueEvents for job-status polling without creating extra
// connections per request. Lazily initialised; callers must handle a
// rejected init when Redis is down.
let queueEvents = null;
export async function getQueueEvents() {
  if (!queueEvents) {
    queueEvents = new QueueEvents("pdf-queue", { connection: getRedisOptions() });
    queueEvents.on("error", (err) => {
      console.error("PDF queue events error:", err?.message ?? err);
    });
  }
  return queueEvents;
}
