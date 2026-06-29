// api/setup.js — open ONCE after deploy (with ?key=CRON_SECRET) to point the
// Telegram webhook at THIS deployment's /api/telegram. Derives its own URL from
// the request host, drops the old polling backlog, and sets the secret token.
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const key = (req.query && req.query.key) || "";
  if (secret && key !== secret) return res.status(401).json({ ok: false, error: "unauthorized" });

  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TOKEN) return res.status(500).json({ ok: false, error: "missing TELEGRAM_BOT_TOKEN" });

  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const webhookUrl = `${proto}://${host}/api/telegram`;

  const params = new URLSearchParams({
    url: webhookUrl,
    drop_pending_updates: "true",
    allowed_updates: JSON.stringify(["message", "edited_message", "channel_post"]),
  });
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookSecret) params.set("secret_token", webhookSecret);

  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook?${params.toString()}`);
  const data = await r.json().catch(() => ({}));
  return res.status(200).json({ ok: data.ok === true, webhookUrl, telegram: data });
}
