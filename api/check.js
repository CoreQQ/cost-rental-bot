// api/check.js — Vercel serverless function. Runs ONE check cycle per invocation.
// State + watchdog/heartbeat memory live in Supabase (see supabase.sql).
// Triggered by Vercel Cron or any external scheduler; protected by CRON_SECRET.
//
//   GET/POST /api/check
//     Header:  Authorization: Bearer <CRON_SECRET>   (Vercel Cron sends this automatically)
//     or query: /api/check?key=<CRON_SECRET>          (handy for manual/browser testing)

import { createClient } from "@supabase/supabase-js";
import { runCycle } from "../lib/core.mjs";
import { sendMessage } from "../lib/telegram.mjs";

const TABLE = "cost_rental_schemes";
const META = "watcher_meta";

export default async function handler(req, res) {
  const {
    CRON_SECRET,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    WANT_BEDROOMS = "2,3",
    NOTIFY_ON_UNKNOWN = "true",
    WATCHDOG_AFTER = "3",
    DISABLED_SITES = "",
    HEARTBEAT_HOURS = "24",
  } = process.env;

  // Auth: Vercel Cron sends "Authorization: Bearer <CRON_SECRET>"; also accept ?key= for manual runs.
  const auth = req.headers.authorization || "";
  const keyOk = CRON_SECRET && (auth === `Bearer ${CRON_SECRET}` || req.query?.key === CRON_SECRET);
  if (!keyOk) return res.status(401).json({ error: "unauthorized" });

  for (const [k, v] of Object.entries({ TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY })) {
    if (!v) return res.status(500).json({ error: `missing env ${k}` });
  }

  const disabledSites = new Set(DISABLED_SITES.split(",").map((x) => x.trim()).filter(Boolean));
  const want = new Set(WANT_BEDROOMS.split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)));
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const store = {
    async getAll() {
      const { data, error } = await supabase.from(TABLE).select("*");
      if (error) throw new Error(`supabase select: ${error.message}`);
      return data || [];
    },
    async save(row) {
      const { error } = await supabase.from(TABLE).upsert(row, { onConflict: "url" });
      if (error) throw new Error(`supabase upsert: ${error.message}`);
    },
    async markClosed(openUrls) {
      const { data, error } = await supabase.from(TABLE).select("url").eq("status", "open");
      if (error) throw new Error(`supabase select-open: ${error.message}`);
      const toClose = (data || []).map((r) => r.url).filter((u) => !openUrls.has(u));
      if (toClose.length) {
        const { error: e2 } = await supabase.from(TABLE)
          .update({ status: "closed", notified_open: false, last_seen: new Date().toISOString() })
          .in("url", toClose);
        if (e2) throw new Error(`supabase close: ${e2.message}`);
      }
    },
    async getMeta() {
      const { data, error } = await supabase.from(META).select("data").eq("id", 1).maybeSingle();
      if (error) throw new Error(`supabase meta select: ${error.message}`);
      return data?.data || {};
    },
    async setMeta(m) {
      const { error } = await supabase.from(META).upsert({ id: 1, data: m }, { onConflict: "id" });
      if (error) throw new Error(`supabase meta upsert: ${error.message}`);
    },
  };

  const notify = (text) => sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, text);

  try {
    const summary = await runCycle({
      store, notify, want, disabledSites,
      notifyOnUnknown: NOTIFY_ON_UNKNOWN !== "false",
      watchdogAfter: Number(WATCHDOG_AFTER),
      heartbeatHours: Number(HEARTBEAT_HOURS),
    });
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
