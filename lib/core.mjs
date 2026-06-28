// lib/core.mjs — one check cycle over affordablehomes.ie (the official aggregator
// that lists cost-rental homes from ALL providers: LDA, Tuath, Respond, Oaklee…).
// Storage- and notifier-agnostic: callers inject `store` and `notify`.
//
//   notify: async (htmlText, buttons?) => boolean   // buttons = [[{text,url}], …]
//
// row = { url, title, location, status:'open'|'closed', beds:int[], applyUrl,
//         deadline, provider, notified_open, first_seen, last_seen }

import { parseAffordableList, parseAffordableDetail, htmlToText } from "../parser.mjs";

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
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const SRC = "affordablehomes.ie";
const AH_LIST_URL = "https://affordablehomes.ie/rent/";

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

// Render-proxy fallback (only used if a direct fetch yields nothing).
async function fetchViaReader(url) {
  const headers = { ...BROWSER_HEADERS };
  if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  const res = await fetch(`https://r.jina.ai/${url}`, { headers, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`reader HTTP ${res.status}`);
  return await res.text();
}

// Fetch the /rent/ listing across a few pages (open schemes are newest -> first pages).
async function loadAffordableList(pages = 2) {
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const url = p === 1 ? AH_LIST_URL : `${AH_LIST_URL}?page=${p}`;
    let entries = [];
    try {
      entries = parseAffordableList(htmlToText(await fetchHtml(url)));
    } catch {
      entries = [];
    }
    if (entries.length === 0) {
      try { entries = parseAffordableList(await fetchViaReader(url)); } catch { entries = []; }
    }
    if (entries.length === 0) {
      if (p === 1) throw new Error("0 schemes parsed (direct + proxy)");
      break; // a later page came back empty -> end of list
    }
    all.push(...entries);
  }
  const seen = new Set();
  return all.filter((e) => !seen.has(e.slug) && seen.add(e.slug));
}

// Fetch a scheme's detail page -> { beds, applyUrl, deadline, provider }.
async function loadAffordableDetail(url) {
  let d = { beds: [], applyUrl: null, deadline: "", provider: "" };
  try {
    d = parseAffordableDetail(htmlToText(await fetchHtml(url)));
  } catch { /* try proxy below */ }
  if (!d.beds.length && !d.applyUrl) {
    try { d = parseAffordableDetail(await fetchViaReader(url)); } catch { /* keep */ }
  }
  return d;
}

// ---- message templates (RU) ----
const bedsLabel = (beds, want, unknown) => {
  if (unknown) return "не указано — проверьте на странице";
  const arr = [...beds].sort((a, b) => a - b);
  const matched = arr.filter((b) => want.has(b));
  return (matched.length ? matched : arr).map((b) => (b === 0 ? "студия" : `${b}-комн.`)).join(", ");
};

const applyButtons = (applyUrl, detailUrl) => {
  const rows = [];
  if (applyUrl) rows.push([{ text: "📝 Податься", url: applyUrl }]);
  rows.push([{ text: "ℹ️ Подробнее", url: detailUrl }]);
  return rows;
};

function fmtAlert(row, unknown, want) {
  const lines = [`🏠 <b>Открыт приём заявок!</b>`, ``, `<b>${esc(row.title)}</b>`];
  if (row.location) lines.push(`📍 ${esc(row.location)}`);
  lines.push(`🛏 Спальни: ${esc(bedsLabel(row.beds, want, unknown))}`);
  if (row.provider) lines.push(`🏢 ${esc(row.provider)}`);
  if (row.deadline) lines.push(`⏳ Приём до: ${esc(row.deadline)}`);
  return lines.join("\n");
}
const fmtWatchdog = (reason) =>
  `⚠️ <b>Проблема со слежением</b>\n\n<b>Источник:</b> ${SRC}\n<b>Причина:</b> ${esc(reason)}\n\nВозможно, изменилась вёрстка или сайт недоступен. Бот продолжит попытки.`;
const fmtRecovered = () => `✅ <b>${SRC}</b> снова отвечает — слежение восстановлено.`;
function fmtHeartbeat(summary, openMatched) {
  const head = summary.ok
    ? `• ${SRC}: ок (открыто ${summary.open} из ${summary.total})`
    : `• ${SRC}: не отвечает`;
  const tail = openMatched.length
    ? `\n\nСейчас открыто и подходит (2–3 комн.): ${openMatched.map(esc).join(", ")}`
    : `\n\nПодходящего открытого жилья сейчас нет.`;
  return `💓 <b>Бот жив</b> — проверка выполнена.\n${head}${tail}`;
}

export async function runCycle({
  store, notify, want, notifyOnUnknown = true, watchdogAfter = 2,
  heartbeatHours = 24, listPages = 2, now,
}) {
  const ts = now ? new Date(now) : new Date();
  const nowIso = ts.toISOString();
  const byUrl = new Map((await store.getAll()).map((r) => [r.url, r]));
  const meta = (await store.getMeta()) || {};
  meta.fails = meta.fails || {};
  meta.watchdogAlerted = meta.watchdogAlerted || {};

  const summary = { ts: nowIso, ok: false, total: 0, open: 0, notified: [], watchdog: [], heartbeat: false };

  let listing;
  try {
    listing = await loadAffordableList(listPages);
  } catch (e) {
    meta.fails[SRC] = (meta.fails[SRC] || 0) + 1;
    if (meta.fails[SRC] >= watchdogAfter && !meta.watchdogAlerted[SRC]) {
      await notify(fmtWatchdog(e.message));
      meta.watchdogAlerted[SRC] = true;
      summary.watchdog.push({ event: "alert", reason: e.message });
    }
    await store.setMeta(meta);
    summary.error = e.message;
    return summary;
  }

  if (meta.watchdogAlerted[SRC]) {
    await notify(fmtRecovered());
    summary.watchdog.push({ event: "recovered" });
  }
  meta.fails[SRC] = 0;
  meta.watchdogAlerted[SRC] = false;

  summary.ok = true;
  summary.total = listing.length;
  const openEntries = listing.filter((e) => e.open);
  summary.open = openEntries.length;

  const openUrls = new Set();
  const openMatched = [];

  for (const entry of openEntries) {
    openUrls.add(entry.url);
    const prev = byUrl.get(entry.url);
    // Fetch the detail page only when we don't already have bed info (new scheme).
    let detail = null;
    let beds = prev?.beds?.length ? prev.beds : null;
    if (!beds) {
      detail = await loadAffordableDetail(entry.url);
      beds = detail.beds;
    }
    const bedsArr = [...(beds || [])].sort((a, b) => a - b);
    const matched = bedsArr.filter((b) => want.has(b));
    const unknown = bedsArr.length === 0;
    const wanted = matched.length > 0 || (unknown && notifyOnUnknown);
    if (wanted) openMatched.push(entry.title);

    const row = {
      url: entry.url,
      title: entry.title,
      location: entry.location || prev?.location || "",
      status: "open",
      beds: bedsArr,
      applyUrl: detail?.applyUrl || prev?.applyUrl || null,
      deadline: detail?.deadline || prev?.deadline || "",
      provider: detail?.provider || prev?.provider || "",
      notified_open: prev?.notified_open ?? false,
      first_seen: prev?.first_seen ?? nowIso,
      last_seen: nowIso,
    };
    if (wanted && !row.notified_open) {
      await notify(fmtAlert(row, unknown, want), applyButtons(row.applyUrl, entry.url));
      row.notified_open = true;
      summary.notified.push({ title: entry.title, beds: bedsArr, unknown });
    }
    await store.save(row);
  }

  await store.markClosed(openUrls);

  if (heartbeatHours > 0) {
    const last = meta.lastHeartbeat ? new Date(meta.lastHeartbeat).getTime() : 0;
    if (ts.getTime() - last >= heartbeatHours * 3600 * 1000) {
      await notify(fmtHeartbeat(summary, openMatched));
      meta.lastHeartbeat = nowIso;
      summary.heartbeat = true;
    }
  }

  await store.setMeta(meta);
  return summary;
}

// ---- On-demand "/all": list every open scheme (any size) ------------------
export async function listAllSchemes({ listPages = 3 } = {}) {
  try {
    return { ok: true, schemes: await loadAffordableList(listPages) };
  } catch (e) {
    return { ok: false, error: e.message, schemes: [] };
  }
}

// Returns { text, buttons } for the Telegram message.
export function formatAllSchemes(result) {
  if (!result.ok) {
    return { text: "⚠️ Не удалось получить список (источник недоступен). Попробуйте позже.", buttons: null };
  }
  const open = result.schemes.filter((s) => s.open);
  const soon = result.schemes.filter((s) => s.status === "soon");
  if (!open.length) {
    let t = "🏠 Сейчас нет открытых схем для подачи.";
    if (soon.length) t += `\n\n🔜 Скоро: ${soon.map((s) => esc(s.title)).join(", ")}`;
    return { text: t, buttons: null };
  }
  const lines = [`🏠 <b>Открыто к подаче: ${open.length}</b>`, `📍 = Дублин`, ``];
  const buttons = [];
  for (const s of open) {
    const dub = /dublin|дублин/i.test(`${s.title} ${s.location}`) ? "📍" : "▫️";
    const loc = s.location ? ` — ${esc(s.location)}` : "";
    lines.push(`${dub} <b>${esc(s.title)}</b>${loc}`);
    buttons.push([{ text: `📝 ${s.title}`.slice(0, 38), url: s.url }]);
  }
  if (soon.length) lines.push(``, `🔜 Скоро: ${soon.map((s) => esc(s.title)).join(", ")}`);
  return { text: lines.join("\n"), buttons };
}
