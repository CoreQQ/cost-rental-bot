// lib/commands.mjs — answers on-demand Telegram commands (polled each run).
// "/all" (or "/list", "список", "доступн…") works IN THE GROUP or as a PRIVATE DM
// to the bot. The housing list is always posted to the GROUP; private senders get
// a confirmation. Optional ADMIN_USER_ID restricts who may trigger it from a DM.
import { sendMessage, getUpdates } from "./telegram.mjs";
import { listAllSchemes, formatAllSchemes } from "./core.mjs";

const TRIGGER = /\/all|\/list|список|доступн/i;

export async function handleCommands({ store, token, groupChatId, adminUserId }) {
  const meta = await store.getMeta();

  let updates = [];
  try {
    updates = await getUpdates(token, meta.tgOffset || 0);
  } catch {
    return { handled: false };
  }
  if (!updates.length) return { handled: false };

  let maxId = (meta.tgOffset || 1) - 1;
  let postToGroup = false;
  const confirmChats = new Set();

  for (const u of updates) {
    if (u.update_id > maxId) maxId = u.update_id;
    const msg = u.message || u.channel_post || u.edited_message;
    if (!msg || !TRIGGER.test(msg.text || "")) continue;

    const fromGroup = String(msg.chat?.id) === String(groupChatId);
    const fromPrivate = msg.chat?.type === "private";
    const authorized =
      fromGroup || (fromPrivate && (!adminUserId || String(msg.from?.id) === String(adminUserId)));
    if (!authorized) {
      if (fromPrivate && msg.chat?.id) {
        await sendMessage(token, msg.chat.id, `⛔ Не авторизовано. Ваш ID: <code>${msg.from?.id}</code>`);
      }
      continue;
    }
    postToGroup = true;
    if (fromPrivate && msg.chat?.id) confirmChats.add(msg.chat.id);
  }

  meta.tgOffset = maxId + 1;
  await store.setMeta(meta);

  if (!postToGroup) return { handled: false };

  const { text, buttons } = formatAllSchemes(await listAllSchemes());
  await sendMessage(token, groupChatId, text, buttons);
  for (const cid of confirmChats) await sendMessage(token, cid, "✅ Список отправлен в группу.");
  return { handled: true };
}
