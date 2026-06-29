// api/scan.js — one scan cycle (new openings -> alerts, watchdog, heartbeat).
// Reuses the exact runCycle logic; state lives in Upstash. Triggered by Vercel
// Cron (daily on Hobby) and/or an external scheduler hitting /api/scan?key=SECRET.
import { runCycle } from "../lib/core.mjs";
import { sendToGroup } from "../lib/telegram.mjs";
import { makeKvStore } from "../lib/kvstore.mjs";

export default async function handler(req, res) {
  // Auth: Vercel Cron sends "Authorization: Bearer <CRON_SECRET>"; an external
  // pinger can instead pass ?key=<CRON_SECRET>.
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const key = (req.query && req.query.key) || "";
  if (secret && auth !== `Bearer ${secret}` && key !== secret) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  if (!TOKEN || !CHAT_ID) {
    return res.status(500).json({ ok: false, error: "missing TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID" });
  }

  try {
    const store = await makeKvStore();
    const want = new Set(
      (process.env.WANT_BEDROOMS ?? "2,3").split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n))
    );
    const notify = (text, buttons) => sendToGroup(TOKEN, store, CHAT_ID, text, buttons);

    const summary = await runCycle({
      store,
      notify,
      want,
      notifyOnUnknown: (process.env.NOTIFY_ON_UNKNOWN ?? "true") !== "false",
      watchdogAfter: Number(process.env.WATCHDOG_AFTER ?? 2),
      heartbeatHours: Number(process.env.HEARTBEAT_HOURS ?? 24),
      listPages: Number(process.env.LIST_PAGES ?? 2),
    });

    console.log(
      `scan: ok=${summary.ok} open=${summary.open}/${summary.total} notified=${summary.notified.length} heartbeat=${summary.heartbeat}`
    );
    return res.status(200).json({ ok: true, summary });
  } catch (e) {
    console.error("scan error:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
