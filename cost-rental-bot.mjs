// cost-rental-bot.mjs — standalone runtime (always-on process; state in a JSON file).
//
// Run:   node --env-file=.env cost-rental-bot.mjs
//   or:  TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node cost-rental-bot.mjs
// Find your chat id:  node cost-rental-bot.mjs --get-chat-id

import { runCycle } from "./lib/core.mjs";
import { makeFileStore } from "./lib/filestore.mjs";
import { sendMessage, getChatIds } from "./lib/telegram.mjs";

// ---------- Config ----------
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_MIN = Number(process.env.POLL_INTERVAL_MIN ?? 15);
const WANT = new Set((process.env.WANT_BEDROOMS ?? "2,3").split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)));
const NOTIFY_ON_UNKNOWN = (process.env.NOTIFY_ON_UNKNOWN ?? "true") !== "false";
const WATCHDOG_AFTER = Number(process.env.WATCHDOG_AFTER ?? 3);
const HEARTBEAT_HOURS = Number(process.env.HEARTBEAT_HOURS ?? 24);
const SEND_STARTUP = (process.env.SEND_STARTUP ?? "true") !== "false";
const STATE_FILE = process.env.STATE_FILE ?? "./state.json";

const log = (...a) => console.log(new Date().toISOString(), ...a);

const store = makeFileStore(STATE_FILE);
const notify = (text) => sendMessage(TOKEN, CHAT_ID, text);

async function cycle() {
  try {
    const s = await runCycle({
      store, notify, want: WANT, notifyOnUnknown: NOTIFY_ON_UNKNOWN,
      watchdogAfter: WATCHDOG_AFTER, heartbeatHours: HEARTBEAT_HOURS,
    });
    const sites = Object.entries(s.sites)
      .map(([n, x]) => `${n}:${x.error ? "ERR" : x.open + "/" + x.total}`).join(" ");
    log(`cycle ok — ${sites}` +
      (s.notified.length ? ` — 🔔 ${s.notified.length}` : "") +
      (s.watchdog.length ? ` — ⚠️ ${s.watchdog.length}` : "") +
      (s.heartbeat ? " — 💓" : ""));
  } catch (e) {
    log("cycle error:", e.message);
  }
}

async function main() {
  if (process.argv.includes("--get-chat-id")) {
    if (!TOKEN) { console.error("Set TELEGRAM_BOT_TOKEN first."); process.exit(1); }
    const ids = await getChatIds(TOKEN);
    if (!ids.length) console.log('No chats yet. Message your bot, then re-run with --get-chat-id.');
    else { console.log("Chat IDs:"); ids.forEach((i) => console.log("  " + i)); }
    return;
  }

  if (!TOKEN || !CHAT_ID) {
    console.error("❌ Missing TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID. See README.md.");
    process.exit(1);
  }

  log(`Started. Watching ${3} sites for ${[...WANT].sort().join("/")}-bed; every ${POLL_MIN} min.`);
  if (SEND_STARTUP) {
    await notify(`✅ <b>Бот запущен</b>\nСлежу за 3 сайтами (LDA, Tuath, Respond) — ищу <b>${[...WANT].sort().join("/")}-комн.</b> жильё.\nПроверка каждые ${POLL_MIN} мин.`);
  }
  await cycle();
  setInterval(cycle, POLL_MIN * 60 * 1000);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
