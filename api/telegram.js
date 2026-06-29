// api/telegram.js — Telegram webhook. Telegram pushes every update here, so
// commands are answered INSTANTLY (no polling). "/all" (or "/list", "список",
// "доступн…") replies in the same chat with the current open schemes, fetched live.
import { listAllSchemes, formatAllSchemes } from "../lib/core.mjs";
import { sendMessage } from "../lib/telegram.mjs";

const TRIGGER = /\/all|\/list|список|доступн/i;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true, note: "webhook up" });

  // Verify the secret set during setWebhook (blocks random POSTs to this URL).
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    return res.status(401).json({ ok: false });
  }

  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  try {
    const update = req.body && typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    const msg = update.message || update.edited_message || update.channel_post;
    const text = msg?.text || "";
    const chatId = msg?.chat?.id;

    if (msg && chatId != null && TRIGGER.test(text)) {
      const adminUserId = process.env.ADMIN_USER_ID;
      const isPrivate = msg.chat?.type === "private";
      const authorized = !isPrivate || !adminUserId || String(msg.from?.id) === String(adminUserId);

      if (!authorized) {
        await sendMessage(TOKEN, chatId, `⛔ Не авторизовано. Ваш ID: <code>${msg.from?.id}</code>`);
      } else {
        const listPages = Number(process.env.LIST_PAGES ?? 2);
        const { text: out, buttons } = formatAllSchemes(await listAllSchemes({ listPages }));
        await sendMessage(TOKEN, chatId, out, buttons);
      }
    }
  } catch (e) {
    console.error("webhook error:", e.message); // always 200 so Telegram doesn't retry-storm
  }
  return res.status(200).json({ ok: true });
}
