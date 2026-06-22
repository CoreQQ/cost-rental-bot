// cost-rental-bot.mjs
// Watches LDA, Tuath and Respond cost-rental pages and pings Telegram the moment
// a 2- or 3-bed scheme opens for applications.
//
// Run:   node --env-file=.env cost-rental-bot.mjs
//   or:  TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node cost-rental-bot.mjs
// Helper to find your chat id:  node cost-rental-bot.mjs --get-chat-id

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { load } from "cheerio";
import { extractEntries, bedroomsFromText, SITES } from "./parser.mjs";

// ---------- Config (env) ----------
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_MIN = Number(process.env.POLL_INTERVAL_MIN ?? 15);
const WANT = new Set(
  (process.env.WANT_BEDROOMS ?? "2,3").split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n))
);
const NOTIFY_ON_UNKNOWN = (process.env.NOTIFY_ON_UNKNOWN ?? "true") !== "false";
const SEND_STARTUP = (process.env.SEND_STARTUP ?? "true") !== "false";
const STATE_FILE = process.env.STATE_FILE ?? "./state.json";
const UA = "Mozilla/5.0 (compatible; CostRentalWatcher/1.0; +personal-use)";

// ---------- Tiny helpers ----------
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) log("⚠️  Telegram error:", res.status, JSON.stringify(data).slice(0, 300));
  return data;
}

const sendMessage = (text) =>
  tg("sendMessage", { chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: false });

// ---------- State ----------
function loadState() {
  if (!existsSync(STATE_FILE)) return { schemes: {} };
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return { schemes: {} }; }
}
function saveState(state) {
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE); // atomic
}

// ---------- Bedroom resolution ----------
// Use beds from the card; fall back to the detail page; cache the result in state.
export async function resolveBeds(entry, prev) {
  if (prev?.beds?.length) return new Set(prev.beds);
  if (entry.cardBeds?.length) return new Set(entry.cardBeds);
  try {
    const html = await fetchHtml(entry.url);
    const $ = load(html);
    $("script,style,noscript,header,footer,nav").remove();
    const text = ($("main").text() || $("body").text() || "");
    return bedroomsFromText(text);
  } catch (e) {
    log("   (detail fetch failed for beds:", entry.url, "-", e.message + ")");
    return new Set(); // unknown
  }
}

// ---------- Notification ----------
export function formatAlert(siteLabel, entry, beds, unknown) {
  const matched = [...beds].filter((b) => WANT.has(b)).sort();
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

// ---------- One polling cycle ----------
export async function runCycle(state) {
  const nowOpenUrls = new Set();

  for (const site of SITES) {
    try {
      const html = await fetchHtml(site.url);
      const entries = extractEntries(html, site.url, site.detailPattern);
      if (entries.length === 0) {
        log(`⚠️  ${site.name}: 0 schemes parsed — page layout may have changed.`);
        continue;
      }
      const openEntries = entries.filter((e) => site.isOpen(e));
      log(`${site.name}: ${entries.length} schemes, ${openEntries.length} open.`);

      for (const entry of openEntries) {
        nowOpenUrls.add(entry.url);
        const prev = state.schemes[entry.url];

        const beds = await resolveBeds(entry, prev);
        const bedsArr = [...beds].sort();
        const matched = bedsArr.filter((b) => WANT.has(b));
        const unknown = beds.size === 0;
        const wanted = matched.length > 0 || (unknown && NOTIFY_ON_UNKNOWN);

        const record = {
          site: site.name,
          title: entry.title,
          status: "open",
          beds: bedsArr,
          notifiedOpen: prev?.notifiedOpen ?? false,
          firstSeen: prev?.firstSeen ?? new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        };

        if (wanted && !record.notifiedOpen) {
          await sendMessage(formatAlert(site.label, entry, beds, unknown));
          record.notifiedOpen = true;
          log(`   🔔 NOTIFIED: ${site.name} — ${entry.title} [${unknown ? "beds?" : bedsArr.join("/")}]`);
        }
        state.schemes[entry.url] = record;
      }
    } catch (e) {
      log(`❌ ${site.name} failed:`, e.message);
    }
    await sleep(1500); // be polite between sites
  }

  // Anything previously open but no longer open -> mark closed and re-arm for next opening.
  for (const [url, rec] of Object.entries(state.schemes)) {
    if (rec.status === "open" && !nowOpenUrls.has(url)) {
      rec.status = "closed";
      rec.notifiedOpen = false;
      rec.lastSeen = new Date().toISOString();
      log(`   closed again: ${rec.site} — ${rec.title}`);
    }
  }

  saveState(state);
}

// ---------- Chat-id helper ----------
async function printChatId() {
  if (!TOKEN) { console.error("Set TELEGRAM_BOT_TOKEN first."); process.exit(1); }
  const data = await tg("getUpdates", {});
  const ids = new Set();
  for (const u of data.result || []) {
    const c = u.message?.chat || u.channel_post?.chat || u.my_chat_member?.chat;
    if (c) ids.add(`${c.id}  (${c.type}${c.title ? ": " + c.title : c.username ? ": @" + c.username : ""})`);
  }
  if (ids.size === 0) console.log('No chats yet. Send any message to your bot, then re-run with --get-chat-id.');
  else { console.log("Chat IDs:"); ids.forEach((i) => console.log("  " + i)); }
}

// ---------- Main ----------
async function main() {
  if (process.argv.includes("--get-chat-id")) return printChatId();

  if (!TOKEN || !CHAT_ID) {
    console.error("❌ Missing TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID.");
    console.error("   See README.md for setup.");
    process.exit(1);
  }

  log(`Started. Watching ${SITES.length} sites for ${[...WANT].sort().join("/")}-bed; every ${POLL_MIN} min.`);
  if (SEND_STARTUP) {
    const wantLabel = [...WANT].sort().join("/");
    await sendMessage(
      `✅ <b>Бот запущен</b>\nСлежу за ${SITES.length} сайтами (LDA, Tuath, Respond) — ищу <b>${wantLabel}-комн.</b> жильё.\nПроверка каждые ${POLL_MIN} мин.`
    );
  }

  const state = loadState();
  await runCycle(state);
  setInterval(() => { runCycle(state).catch((e) => log("cycle error:", e.message)); }, POLL_MIN * 60 * 1000);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
