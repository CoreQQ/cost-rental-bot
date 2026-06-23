// lib/telegram.mjs — single place that talks to the Telegram Bot API.
export async function sendMessage(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
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

export async function getUpdates(token, offset = 0) {
  const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=0${offset ? `&offset=${offset}` : ""}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  return data.ok ? data.result || [] : [];
}
