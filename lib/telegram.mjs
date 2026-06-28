// lib/telegram.mjs — single place that talks to the Telegram Bot API.
// `buttons` is an optional array of rows, each row an array of { text, url }.
export async function sendMessage(token, chatId, text, buttons = null) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (buttons && buttons.length) {
    body.reply_markup = { inline_keyboard: buttons };
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.error("Telegram error:", res.status, JSON.stringify(data).slice(0, 200));
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
