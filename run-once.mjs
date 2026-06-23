// run-once.mjs — single check cycle, then exit. Used by GitHub Actions (and any cron).
import { runCycle } from "./lib/core.mjs";
import { makeFileStore } from "./lib/filestore.mjs";
import { sendMessage } from "./lib/telegram.mjs";
import { handleCommands } from "./lib/commands.mjs";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (!TOKEN || !CHAT_ID) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID.");
  process.exit(1);
}

const want = new Set(
  (process.env.WANT_BEDROOMS ?? "2,3").split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n))
);
const disabledSites = new Set(
  (process.env.DISABLED_SITES ?? "").split(",").map((s) => s.trim()).filter(Boolean)
);
const store = makeFileStore(process.env.STATE_FILE ?? "./state.json");
const notify = (text) => sendMessage(TOKEN, CHAT_ID, text);

const summary = await runCycle({
  store,
  notify,
  want,
  disabledSites,
  notifyOnUnknown: (process.env.NOTIFY_ON_UNKNOWN ?? "true") !== "false",
  watchdogAfter: Number(process.env.WATCHDOG_AFTER ?? 2),
  heartbeatHours: Number(process.env.HEARTBEAT_HOURS ?? 24),
});

console.log(
  JSON.stringify(summary.sites),
  `| notified:${summary.notified.length} watchdog:${summary.watchdog.length} heartbeat:${summary.heartbeat}`
);

// Answer any on-demand commands (e.g. /all) sent to the chat.
try {
  const cmd = await handleCommands({ store, token: TOKEN, chatId: CHAT_ID, disabledSites });
  if (cmd.handled) console.log("answered /all command");
} catch (e) {
  console.log("command handling error:", e.message);
}
