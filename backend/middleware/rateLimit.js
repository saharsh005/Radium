/**
 * Zero-dependency fixed-window rate limiter.
 *
 * Keyed by authenticated user when available, otherwise IP. State lives
 * in memory: correct for a single API replica; use Redis when scaling
 * horizontally (see docs/PRODUCTION.md).
 */

const buckets = new Map(); // key → { count, resetAt }

setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref();

export function rateLimit({ windowMs = 60_000, max = 60, keyPrefix = "rl" } = {}) {
  return (req, res, next) => {
    const identity = req.auth?.userId || req.ip || "unknown";
    const key = `${keyPrefix}:${identity}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, max - bucket.count));
    if (bucket.count > max) {
      return res.status(429).json({ error: "Rate limit exceeded, please slow down" });
    }
    next();
  };
}

// Generous: reads and cheap endpoints.
export const readLimiter = rateLimit({ windowMs: 60_000, max: 120, keyPrefix: "rl-read" });
// Strict: LLM calls and uploads (costly / abuse-prone).
export const writeLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10),
  max: parseInt(process.env.RATE_LIMIT_MAX || "30", 10),
  keyPrefix: "rl-write",
});

// Test hook: reset all buckets.
export function _resetRateLimits() {
  buckets.clear();
}
