// lib/core.mjs — the one cycle, shared by the standalone runtime and the Vercel function.
// Storage- and notifier-agnostic: callers inject a `store` and a `notify` function.
//
//   store: {
//     getAll(): row[]                         // rows of watched schemes
//     save(row)                               // upsert one scheme row
//     markClosed(openUrls: Set<string>)       // close rows no longer open + re-arm
//     getMeta(): object                       // small watchdog/heartbeat state bag
//     setMeta(obj)                            // persist it
//   }
//   notify: async (htmlText) => boolean       // send one Telegram message
//
// row = { url, site, title, status:'open'|'closed', beds:int[], notified_open,
//         first_seen, last_seen }

import { load } from "cheerio";
import { extractEntries, bedroomsFromText, SITES } from "../parser.mjs";

// Look like a normal browser — some sites' WAFs block non-standard/bot user-agents.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const BROWSER_HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-IE,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Cache-Control": "max-age=0",
};
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function fetchHtml(url, { timeoutMs = 9000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 700 * attempt));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow", signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
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

// Render-proxy fallback for sites that block datacenter IPs (e.g. Cloudflare bot
// protection). Jina AI Reader renders the page in a real browser and returns its HTML.
async function fetchViaReader(url) {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { ...BROWSER_HEADERS, "X-Return-Format": "html" },
    signal: AbortSignal.timeout(22000),
  });
  if (!res.ok) throw new Error(`reader HTTP ${res.status}`);
  return await res.text();
}

// Try a direct fetch first; if it errors or yields nothing, retry via the render-proxy.
async function loadSiteEntries(site) {
  let entries = [];
  try {
    const html = await fetchHtml(site.url);
    entries = extractEntries(html, site.url, site.detailPattern);
  } catch {
    entries = [];
  }
  if (entries.length === 0) {
    const html = await fetchViaReader(site.url);
    entries = extractEntries(html, site.url, site.detailPattern);
  }
  return entries;
}

// ---- message templates (RU) ----
const bedsLabel = (beds, want, unknown) => {
  if (unknown) return "не указано на карточке — проверьте на сайте";
  const matched = [...beds].filter((b) => want.has(b)).sort((a, b) => a - b);
  const list = matched.length ? matched : [...beds].sort((a, b) => a - b);
  return list.map((b) => (b === 0 ? "студия" : `${b}-комн.`)).join(", ");
};

function fmtAlert(siteLabel, entry, beds, unknown, want) {
  return (
    `🏠 <b>Открыт приём заявок!</b>\n\n` +
    `<b>Сайт:</b> ${esc(siteLabel)}\n` +
    `<b>Объект:</b> ${esc(entry.title)}\n` +
    `<b>Спальни:</b> ${esc(bedsLabel(beds, want, unknown))}\n` +
    `<b>Ссылка:</b> <a href="${esc(entry.url)}">${esc(entry.url)}</a>`
  );
}
const fmtWatchdog = (siteLabel, reason) =>
  `⚠️ <b>Проблема со слежением</b>\n\n<b>Сайт:</b> ${esc(siteLabel)}\n<b>Причина:</b> ${esc(reason)}\n\nВозможно, изменилась вёрстка сайта или он недоступен. Бот продолжит попытки.`;
const fmtRecovered = (siteLabel) => `✅ <b>${esc(siteLabel)}</b> снова отвечает — слежение восстановлено.`;
function fmtHeartbeat(siteStats, openMatched) {
  const lines = Object.entries(siteStats).map(
    ([name, s]) => `• ${name}: ${s.ok ? `ок (${s.open} откр.)` : "не отвечает"}`
  );
  const tail = openMatched.length
    ? `\n\nСейчас открыто (подходит): ${openMatched.map((m) => esc(m)).join(", ")}`
    : "\n\nПодходящего открытого жилья сейчас нет.";
  return `💓 <b>Бот жив</b> — проверка выполнена.\n${lines.join("\n")}${tail}`;
}

/**
 * Run one full check cycle.
 * @param opts { want:Set<number>, notifyOnUnknown:boolean, watchdogAfter:number,
 *               heartbeatHours:number, now?:Date }
 */
export async function runCycle({ store, notify, want, notifyOnUnknown = true, watchdogAfter = 3, heartbeatHours = 24, disabledSites = new Set(), now }) {
  const ts = now ? new Date(now) : new Date();
  const nowIso = ts.toISOString();
  const rows = await store.getAll();
  const byUrl = new Map(rows.map((r) => [r.url, r]));
  const meta = (await store.getMeta()) || {};
  meta.fails = meta.fails || {};
  meta.watchdogAlerted = meta.watchdogAlerted || {};

  const activeSites = SITES.filter((s) => !disabledSites.has(s.name));
  const openUrls = new Set();
  const openMatchedLabels = [];
  const summary = { ts: nowIso, sites: {}, notified: [], watchdog: [], heartbeat: false };

  for (const site of activeSites) {
    let siteStat = { ok: false, total: 0, open: 0 };
    try {
      const entries = await loadSiteEntries(site);
      const open = entries.filter((e) => site.isOpen(e));
      siteStat = { ok: entries.length > 0, total: entries.length, open: open.length };

      if (entries.length === 0) throw new Error("0 schemes parsed (direct + proxy)");

      for (const entry of open) {
        openUrls.add(entry.url);
        const prev = byUrl.get(entry.url);
        const beds = await resolveBeds(entry, prev?.beds);
        const bedsArr = [...beds].sort((a, b) => a - b);
        const matched = bedsArr.filter((b) => want.has(b));
        const unknown = beds.size === 0;
        const wanted = matched.length > 0 || (unknown && notifyOnUnknown);
        if (wanted) openMatchedLabels.push(`${entry.title} (${site.name})`);

        const row = {
          url: entry.url,
          site: site.name,
          title: entry.title,
          status: "open",
          beds: bedsArr,
          notified_open: prev?.notified_open ?? false,
          first_seen: prev?.first_seen ?? nowIso,
          last_seen: nowIso,
        };
        if (wanted && !row.notified_open) {
          await notify(fmtAlert(site.label, entry, beds, unknown, want));
          row.notified_open = true;
          summary.notified.push({ site: site.name, title: entry.title, beds: bedsArr, unknown });
        }
        await store.save(row);
      }

      // success -> reset failure streak; announce recovery if it was alerting
      if (meta.watchdogAlerted[site.name]) {
        await notify(fmtRecovered(site.label));
        summary.watchdog.push({ site: site.name, event: "recovered" });
      }
      meta.fails[site.name] = 0;
      meta.watchdogAlerted[site.name] = false;
    } catch (e) {
      siteStat.error = e.message;
      meta.fails[site.name] = (meta.fails[site.name] || 0) + 1;
      // Alert exactly once when the streak reaches the threshold.
      if (meta.fails[site.name] >= watchdogAfter && !meta.watchdogAlerted[site.name]) {
        await notify(fmtWatchdog(site.label, e.message));
        meta.watchdogAlerted[site.name] = true;
        summary.watchdog.push({ site: site.name, event: "alert", reason: e.message });
      }
    }
    summary.sites[site.name] = siteStat;
  }

  await store.markClosed(openUrls);

  // Heartbeat (throttled).
  if (heartbeatHours > 0) {
    const last = meta.lastHeartbeat ? new Date(meta.lastHeartbeat).getTime() : 0;
    if (ts.getTime() - last >= heartbeatHours * 3600 * 1000) {
      await notify(fmtHeartbeat(summary.sites, openMatchedLabels));
      meta.lastHeartbeat = nowIso;
      summary.heartbeat = true;
    }
  }

  await store.setMeta(meta);
  return summary;
}
