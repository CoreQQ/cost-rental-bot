// api/check.js — Vercel serverless function. Runs ONE check cycle per invocation.
// State lives in Supabase (table `cost_rental_schemes`, see supabase.sql).
// Triggered by Vercel Cron or any external scheduler; protected by CRON_SECRET.
//
// GET/POST /api/check
//   Header:  Authorization: Bearer <CRON_SECRET>   (Vercel Cron sends this automatically)
//   or query: /api/check?key=<CRON_SECRET>          (handy for manual/browser testing)

import { load } from "cheerio";
import { createClient } from "@supabase/supabase-js";
import { extractEntries, bedroomsFromText, SITES } from "../parser.mjs";

const TABLE = "cost_rental_schemes";
const UA = "Mozilla/5.0 (compatible; CostRentalWatcher/1.0; +personal-use)";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: false }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.error("Telegram error:", res.status, JSON.stringify(data).slice(0, 200));
  return data.ok;
}

async function resolveBeds(entry, prevBeds) {
  if (prevBeds?.length) return new Set(prevBeds);
  if (entry.cardBeds?.length) return new Set(entry.cardBeds);
  try {
    const html = await fetchHtml(entry.url);
    const $ = load(html);
    $("script,style,noscript,header,footer,nav").remove();
    return bedroomsFromText($("main").text() || $("body").text() || "");
  } catch {
    return new Set();
  }
}

function formatAlert(siteLabel, entry, beds, unknown, want) {
  const matched = [...beds].filter((b) => want.has(b)).sort();
  const bedsLine = unknown
    ? "не указано на карточке — проверьте на сайте"
    : matched.length
      ? matched.map((b) => `${b}-комн.`).join(", ")
      : [...beds].sort().map((b) => (b === 0 ? "студия" : `${b}-комн.`)).join(", ");
  return (
    `🏠 <b>Открыт приём заявок!</b>\n\n` +
    `<b>Сайт:</b> ${esc(siteLabel)}\n` +
    `<b>Объект:</b> ${esc(entry.title)}\n` +
    `<b>Спальни:</b> ${esc(bedsLine)}\n` +
    `<b>Ссылка:</b> <a href="${esc(entry.url)}">${esc(entry.url)}</a>`
  );
}

/**
 * Core cycle — storage/notify agnostic so it can be unit-tested.
 * @param store  { getAll(): row[], save(row), markClosed(openUrls:Set) }
 * @param notify async (htmlText) => void
 * @param opts   { want:Set<number>, notifyOnUnknown:boolean }
 */
export async function runCheck({ store, notify, want, notifyOnUnknown }) {
  const rows = await store.getAll();
  const byUrl = new Map(rows.map((r) => [r.url, r]));
  const openUrls = new Set();
  const summary = { sites: {}, openCount: 0, notified: [] };

  for (const site of SITES) {
    try {
      const html = await fetchHtml(site.url);
      const entries = extractEntries(html, site.url, site.detailPattern);
      const open = entries.filter((e) => site.isOpen(e));
      summary.sites[site.name] = { total: entries.length, open: open.length };
      if (entries.length === 0) summary.sites[site.name].warning = "0 parsed — layout changed?";

      for (const entry of open) {
        openUrls.add(entry.url);
        summary.openCount++;
        const prev = byUrl.get(entry.url);

        const beds = await resolveBeds(entry, prev?.beds);
        const bedsArr = [...beds].sort((a, b) => a - b);
        const matched = bedsArr.filter((b) => want.has(b));
        const unknown = beds.size === 0;
        const wanted = matched.length > 0 || (unknown && notifyOnUnknown);

        const row = {
          url: entry.url,
          site: site.name,
          title: entry.title,
          status: "open",
          beds: bedsArr,
          notified_open: prev?.notified_open ?? false,
          first_seen: prev?.first_seen ?? new Date().toISOString(),
          last_seen: new Date().toISOString(),
        };

        if (wanted && !row.notified_open) {
          await notify(formatAlert(site.label, entry, beds, unknown, want));
          row.notified_open = true;
          summary.notified.push({ site: site.name, title: entry.title, beds: bedsArr, unknown });
        }
        await store.save(row);
      }
    } catch (e) {
      summary.sites[site.name] = { error: e.message };
    }
  }

  await store.markClosed(openUrls);
  return summary;
}

// ---------- Vercel handler ----------
export default async function handler(req, res) {
  const {
    CRON_SECRET,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    WANT_BEDROOMS = "2,3",
    NOTIFY_ON_UNKNOWN = "true",
  } = process.env;

  // Auth: Vercel Cron sends "Authorization: Bearer <CRON_SECRET>"; also accept ?key= for manual runs.
  const auth = req.headers.authorization || "";
  const keyOk =
    CRON_SECRET &&
    (auth === `Bearer ${CRON_SECRET}` || req.query?.key === CRON_SECRET);
  if (!keyOk) return res.status(401).json({ error: "unauthorized" });

  for (const [k, v] of Object.entries({
    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  })) {
    if (!v) return res.status(500).json({ error: `missing env ${k}` });
  }

  const want = new Set(WANT_BEDROOMS.split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)));
  const notifyOnUnknown = NOTIFY_ON_UNKNOWN !== "false";

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

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
        const { error: e2 } = await supabase
          .from(TABLE)
          .update({ status: "closed", notified_open: false, last_seen: new Date().toISOString() })
          .in("url", toClose);
        if (e2) throw new Error(`supabase close: ${e2.message}`);
      }
    },
  };

  const notify = (text) => sendTelegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, text);

  try {
    const summary = await runCheck({ store, notify, want, notifyOnUnknown });
    return res.status(200).json({ ok: true, ts: new Date().toISOString(), ...summary });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
