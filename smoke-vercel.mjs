// Plumbing + end-to-end smoke test for the Vercel handlers (mocks fetch + req/res).
process.env.TELEGRAM_BOT_TOKEN = "T";
process.env.TELEGRAM_CHAT_ID = "-1004438936269";
process.env.CRON_SECRET = "csecret";
process.env.WEBHOOK_SECRET = "wsecret";
process.env.UPSTASH_REDIS_REST_URL = "https://kv.example.com";
process.env.UPSTASH_REDIS_REST_TOKEN = "kvtok";
process.env.HEARTBEAT_HOURS = "0";

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("✅", m)) : (fail++, console.log("❌", m)));

// Same HTML shapes the core parser is validated against (from ah-test.mjs).
const card = (slug, name, status, loc) =>
  `<div><h3><a href="https://affordablehomes.ie/rent/${slug}/">${name}</a></h3>` +
  `<h4>Status</h4><p>${status}</p><h4>Location</h4><p>${loc}</p>` +
  `<a href="https://affordablehomes.ie/rent/${slug}/">Read More</a></div>`;
const detail = (beds) =>
  `<h2>S</h2><a href="https://tuathhousing.ie/cost-rental/">Apply Now</a>` +
  `<h3>Bedrooms</h3><p>${beds}</p><h3>Approved Housing Body</h3><p>Tuath Housing</p>`;
const listing =
  card("carrig", "Carrigmore Woods", "Applications Open", "Citywest, Co. Dublin") +
  card("onebed", "One Bed Place", "Applications Open", "Cork City") +
  card("shut", "Shut Scheme", "Applications Closed", "Galway");

const html = (s) => ({ ok: true, status: 200, text: async () => s });
let sends = [];
let kv = null;
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.includes("api.telegram.org") && url.includes("/sendMessage")) {
    sends.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  }
  if (url.includes("/get/")) return { ok: true, json: async () => ({ result: kv }) };
  if (url.includes("/set/")) { kv = opts.body; return { ok: true, json: async () => ({ result: "OK" }) }; }
  if (url.includes("affordablehomes")) {
    if (url.includes("/rent/carrig/")) return html(detail("2 Bed"));
    if (url.includes("/rent/onebed/")) return html(detail("1 Bed"));
    if (url.includes("/rent/shut/")) return html(detail("2 Bed"));
    return html(listing); // listing page(s)
  }
  if (url.includes("r.jina.ai")) return { ok: false, status: 404, text: async () => "" };
  return { ok: false, status: 404, text: async () => "" };
};

const mockRes = () => { const r = { code: 200, body: null }; r.status = (c) => (r.code = c, r); r.json = (b) => (r.body = b, r); return r; };
const { default: webhook } = await import("./api/telegram.js");
const { default: scan } = await import("./api/scan.js");

// ---- webhook ----
sends = []; let res = mockRes();
await webhook({ method: "POST", headers: { "x-telegram-bot-api-secret-token": "wsecret" },
  body: { message: { chat: { id: -1004438936269, type: "supergroup" }, text: "/all" } } }, res);
ok(res.code === 200, "webhook returns 200");
ok(sends.length === 1 && String(sends[0].chat_id) === "-1004438936269", "webhook /all -> reply to originating chat");
ok(/Carrigmore Woods/.test(sends[0].text), "webhook /all -> lists live open schemes");

sends = []; res = mockRes();
await webhook({ method: "POST", headers: { "x-telegram-bot-api-secret-token": "WRONG" },
  body: { message: { chat: { id: 1, type: "private" }, text: "/all" } } }, res);
ok(res.code === 401 && sends.length === 0, "webhook rejects wrong secret token");

sends = []; res = mockRes();
await webhook({ method: "POST", headers: { "x-telegram-bot-api-secret-token": "wsecret" },
  body: { message: { chat: { id: 1, type: "supergroup" }, text: "hi" } } }, res);
ok(res.code === 200 && sends.length === 0, "webhook ignores non-command");

process.env.ADMIN_USER_ID = "555";
sends = []; res = mockRes();
await webhook({ method: "POST", headers: { "x-telegram-bot-api-secret-token": "wsecret" },
  body: { message: { chat: { id: 777, type: "private" }, from: { id: 777 }, text: "/all" } } }, res);
ok(sends.length === 1 && /Не авторизовано/.test(sends[0].text), "webhook private admin-lock blocks others");
delete process.env.ADMIN_USER_ID;

// ---- scan ----
res = mockRes();
await scan({ headers: { authorization: "Bearer nope" }, query: {} }, res);
ok(res.code === 401, "scan rejects bad secret");

kv = null; sends = []; res = mockRes();
await scan({ headers: { authorization: "Bearer csecret" }, query: {} }, res);
ok(res.code === 200 && res.body?.summary?.ok === true, "scan runs (Bearer auth) and parses listing");
ok(res.body.summary.open === 2, "scan sees 2 open schemes");
ok(res.body.summary.notified.length === 1 && sends.some((s) => /Carrigmore Woods/.test(s.text) && String(s.chat_id) === "-1004438936269"),
   "scan alerts the matching 2-bed scheme to the group");

sends = []; res = mockRes();
await scan({ headers: {}, query: { key: "csecret" } }, res);
ok(res.code === 200 && res.body.summary.notified.length === 0, "scan re-run (?key= auth) dedups, no repeat alert");

console.log(`\n${fail === 0 ? "✅ SMOKE PASS" : "⚠️ SMOKE FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
