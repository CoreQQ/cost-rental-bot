// lib/telegram.mjs — single place that talks to the Telegram Bot API.
// `buttons` is an optional array of rows, each row an array of { text, url }.
async function postMessage(token, chatId, text, buttons) {
  const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (buttons && buttons.length) body.reply_markup = { inline_keyboard: buttons };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

export async function sendMessage(token, chatId, text, buttons = null) {
  const { status, data } = await postMessage(token, chatId, text, buttons);
  if (!data.ok) console.error("Telegram error:", status, JSON.stringify(data).slice(0, 200));
  return Boolean(data.ok);
}

// Sends to the GROUP, self-healing if it was upgraded to a supergroup. When that
// happens the old chat id stops working and Telegram replies with
// migrate_to_chat_id; we adopt that id, persist it in meta.groupChatId, and retry.
// This fixes a stale TELEGRAM_CHAT_ID so alerts + lists reach the right chat.
export async function sendToGroup(token, store, fallbackChatId, text, buttons = null) {
  const meta = await store.getMeta();
  let chatId = meta.groupChatId || fallbackChatId;
  let { status, data } = await postMessage(token, chatId, text, buttons);
  const migrate = data.parameters && data.parameters.migrate_to_chat_id;
  if (!data.ok && migrate) {
    console.log(`group ${chatId} upgraded to supergroup ${migrate} — adopting new id and retrying`);
    chatId = migrate;
    meta.groupChatId = chatId;
    await store.setMeta(meta);
    ({ status, data } = await postMessage(token, chatId, text, buttons));
  }
  if (!data.ok) console.error("group send error:", status, JSON.stringify(data).slice(0, 200), "chat", chatId);
  return Boolean(data.ok);
}

export async function getChatIds(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const data = await res.json().catch(() => ({}));
  const ids = new Set();
  for (const u of data.result || []) {
    const c = u.message?.chat || u.channel_post?.chat || u.my_chat_member?.chat;
    if (c) ids.add(`${c.id}  (${c.type}${c.title ? ": " + c.title : c.username ? ": @" + c.username : ""})`);
  }
  return [...ids];
}

export async function deleteWebhook(token) {
  // A leftover webhook makes getUpdates fail with HTTP 409 and silently return
  // nothing — so the bot can SEND messages but never RECEIVES commands. Clearing
  // it (idempotent; keeps any pending updates) restores long-polling.
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
    const data = await res.json().catch(() => ({}));
    if (!data.ok) console.log("deleteWebhook not ok:", res.status, JSON.stringify(data).slice(0, 120));
    return !!data.ok;
  } catch (e) {
    console.log("deleteWebhook failed:", e.message);
    return false;
  }
}

export async function getUpdates(token, offset = 0) {
  const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=0${offset ? `&offset=${offset}` : ""}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.log("getUpdates not ok:", res.status, JSON.stringify(data).slice(0, 160));
  return data.ok ? data.result || [] : [];
}
