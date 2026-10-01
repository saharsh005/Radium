#!/usr/bin/env node
/**
 * Redis connection diagnostic.
 *
 *   cd backend && node eval/redis-probe.js
 *
 * Tests each layer separately — DNS → TCP → TLS → Redis PING — using the
 * same REDIS_URL / REDIS_HOST / REDIS_PORT / REDIS_TLS resolution as the
 * worker (queue/redisConnection.js). Never prints credentials.
 */
import dns from "dns/promises";
import net from "net";
import tls from "tls";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

import { createRedisConnection } from "../queue/redisConnection.js";

const opts = createRedisConnection();
const useTls = !!opts.tls;
console.log(`Target: ${opts.host}:${opts.port} (TLS ${useTls ? "on" : "off"})`);

async function stage(name, fn, timeoutMs = 10_000) {
  const t0 = Date.now();
  try {
    const detail = await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
    ]);
    console.log(`[PASS] ${name} (${Date.now() - t0}ms)${detail ? " — " + detail : ""}`);
    return true;
  } catch (err) {
    console.log(`[FAIL] ${name} (${Date.now() - t0}ms) — ${err.message}`);
    return false;
  }
}

const okDns = await stage("DNS resolve", async () => {
  const addrs = await dns.lookup(opts.host);
  return addrs[0];
});
if (!okDns) {
  console.log("Diagnosis: DNS cannot resolve the Redis host. Check VPN/firewall DNS or a typo in REDIS_URL/REDIS_HOST.");
  process.exit(2);
}

const okTcp = await stage("TCP connect", () => new Promise((resolve, reject) => {
  const sock = net.connect({ host: opts.host, port: opts.port });
  sock.on("connect", () => { sock.destroy(); resolve("connected"); });
  sock.on("error", reject);
}));
if (!okTcp) {
  console.log("Diagnosis: TCP to port " + opts.port + " is blocked. Allow outbound 6379 or switch to local Redis (see docs/PRODUCTION.md).");
  process.exit(2);
}

if (useTls) {
  const okTls = await stage("TLS handshake", () => new Promise((resolve, reject) => {
    const sock = tls.connect({ host: opts.host, port: opts.port, servername: opts.host });
    sock.on("secureConnect", () => { sock.destroy(); resolve("certificate accepted"); });
    sock.on("error", reject);
  }));
  if (!okTls) {
    console.log("Diagnosis: TLS handshake fails (the ECONNRESET pattern). A middlebox may be intercepting port 6379, or the server expects plain Redis. If self-hosted, try REDIS_TLS unset.");
    process.exit(2);
  }
}

const okPing = await stage("Redis PING (auth)", async () => {
  const { default: Redis } = await import("ioredis");
  const client = new Redis({ ...opts, lazyConnect: true, maxRetriesPerRequest: 1, enableReadyCheck: false });
  try {
    await client.ping();
    return "PONG";
  } finally {
    client.disconnect();
  }
});
if (!okPing) {
  console.log("Diagnosis: connected but Redis rejected the command — usually a wrong password (check REDIS_URL) or ACL issue.");
  process.exit(2);
}

console.log("All stages passed — the worker should connect. If it still logs errors, restart it to pick up the current .env.");
