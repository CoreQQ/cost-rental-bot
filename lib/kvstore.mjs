// lib/kvstore.mjs — Upstash Redis (REST) store, same interface as filestore.
// The whole bot state ({schemes, meta}) lives under one key. No SDK needed: we
// talk to the Upstash REST API with fetch, so it works in any serverless runtime.
// Env (auto-injected by Vercel's Upstash/KV integration; we accept either naming):
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (Upstash integration)
//   KV_REST_API_URL        / KV_REST_API_TOKEN         (legacy Vercel KV)
const KEY = "cost-rental:state";

function kvEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Missing KV env. Connect Upstash in Vercel (Storage) — it sets UPSTASH_REDIS_REST_URL/TOKEN."
    );
  }
  return { url: url.replace(/\/+$/, ""), token };
}

async function kvGet() {
  const { url, token } = kvEnv();
  const res = await fetch(`${url}/get/${encodeURIComponent(KEY)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (data && typeof data.result === "string" && data.result.length) {
    try { return JSON.parse(data.result); } catch { return null; }
  }
  return null;
}

async function kvSet(value) {
  const { url, token } = kvEnv();
  // Upstash REST SET accepts the value in the request body (stored verbatim).
  const res = await fetch(`${url}/set/${encodeURIComponent(KEY)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!res.ok) console.error("kv set failed:", res.status);
  return res.ok;
}

// Loads state once, mutates in memory, writes the whole blob back on each change
// (same semantics as the file store, just persisted to Redis).
export async function makeKvStore() {
  const data = (await kvGet()) || { schemes: {}, meta: {} };
  data.schemes ||= {};
  data.meta ||= {};
  const flush = () => kvSet(data);

  return {
    async getAll() { return Object.values(data.schemes); },
    async save(row) { data.schemes[row.url] = row; await flush(); },
    async markClosed(openUrls) {
      for (const r of Object.values(data.schemes)) {
        if (r.status === "open" && !openUrls.has(r.url)) {
          r.status = "closed";
          r.notified_open = false;
          r.last_seen = new Date().toISOString();
        }
      }
      await flush();
    },
    async getMeta() { return data.meta; },
    async setMeta(m) { data.meta = m; await flush(); },
  };
}
