// lib/commands.mjs — answers on-demand Telegram commands (polled each run).
// "/all" (or "/list", "список", "доступн…") works in the GROUP or as a PRIVATE DM.
// The housing list is always posted to the configured GROUP (TELEGRAM_CHAT_ID).
// Robust to supergroup-id changes: accepts the command from any group the bot is in.
import { sendMessage, sendToGroup, getUpdates, deleteWebhook } from "./telegram.mjs";
import { listAllSchemes, formatAllSchemes } from "./core.mjs";

const TRIGGER = /\/all|\/list|список|доступн/i;

export async function handleCommands({ store, token, groupChatId, adminUserId }) {
  const meta = await store.getMeta();

  // Ensure polling works: a stray webhook would block getUpdates (409) entirely.
  await deleteWebhook(token);

  let updates = [];
  try {
    updates = await getUpdates(token, meta.tgOffset || 0);
  } catch (e) {
    console.log("cmd: getUpdates failed:", e.message);
    return { handled: false };
  }
  console.log(`cmd: fetched ${updates.length} update(s)`);
  if (!updates.length) return { handled: false };

  let maxId = (meta.tgOffset || 1) - 1;
  let postToGroup = false;
  const confirmChats = new Set();

  for (const u of updates) {
    if (u.update_id > maxId) maxId = u.update_id;
    const msg = u.message || u.channel_post || u.edited_message;
    if (!msg) continue;
    if (!TRIGGER.test(msg.text || "")) continue;

    const type = msg.chat?.type;
    const chatId = msg.chat?.id;
    console.log(`cmd: trigger in chat ${chatId} (${type}) from user ${msg.from?.id}`);

    const isPrivate = type === "private";
    const isGroup = type === "group" || type === "supergroup";
    const authorized = isGroup || (isPrivate && (!adminUserId || String(msg.from?.id) === String(adminUserId)));
    if (!authorized) {
      if (isPrivate && chatId) {
        await sendMessage(token, chatId, `⛔ Не авторизовано. Ваш ID: <code>${msg.from?.id}</code>`);
      }
      continue;
    }
    postToGroup = true;
    // Learn the group's real id (supergroup upgrades change it) so alerts land there too.
    if (isGroup && chatId != null) meta.groupChatId = chatId;
    if (isPrivate && chatId) confirmChats.add(chatId);
  }

  meta.tgOffset = maxId + 1;
  await store.setMeta(meta);

  if (!postToGroup) {
    console.log("cmd: no authorized /all trigger found");
    return { handled: false };
  }

  const { text, buttons } = formatAllSchemes(await listAllSchemes());
  await sendToGroup(token, store, groupChatId, text, buttons);
  for (const cid of confirmChats) await sendMessage(token, cid, "✅ Список отправлен в группу.");
  return { handled: true };
}
