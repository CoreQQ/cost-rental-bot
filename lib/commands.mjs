// lib/commands.mjs — answers on-demand Telegram commands (polled each run).
// Trigger: "/all", "/list", "список", or any "доступн..." in the watched chat.
import { sendMessage, getUpdates } from "./telegram.mjs";
import { listAllSchemes, formatAllSchemes } from "./core.mjs";

const TRIGGER = /\/all|\/list|список|доступн/i;

export async function handleCommands({ store, token, chatId, disabledSites = new Set() }) {
  const meta = await store.getMeta();

  let updates = [];
  try {
    updates = await getUpdates(token, meta.tgOffset || 0);
  } catch {
    return { handled: false };
  }
  if (!updates.length) return { handled: false };

  let maxId = (meta.tgOffset || 1) - 1;
  let wantList = false;
  for (const u of updates) {
    if (u.update_id > maxId) maxId = u.update_id;
    const msg = u.message || u.channel_post || u.edited_message;
    if (!msg || String(msg.chat?.id) !== String(chatId)) continue;
    if (TRIGGER.test(msg.text || "")) wantList = true;
  }

  // Advance the offset so we never re-process these updates (no repeats/spam).
  meta.tgOffset = maxId + 1;
  await store.setMeta(meta);

  if (!wantList) return { handled: false };

  const result = await listAllSchemes({ disabledSites });
  await sendMessage(token, chatId, formatAllSchemes(result));
  return { handled: true };
}
