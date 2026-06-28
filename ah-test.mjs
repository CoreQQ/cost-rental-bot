// ah-test.mjs — affordablehomes parsers + runCycle (alerts/buttons/dedup/re-arm/watchdog/heartbeat) + /all.
import { parseAffordableList, parseAffordableDetail, htmlToText } from "./parser.mjs";
import { runCycle, listAllSchemes, formatAllSchemes } from "./lib/core.mjs";
import { handleCommands } from "./lib/commands.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  ❌", m); } };

// ---------- A. parsers ----------
const listMd = `### [Carrigmore Woods](https://affordablehomes.ie/rent/carrigmorewoods/)
#### Status
Applications Open
#### Location
Citywest, Co. Dublin
[Read More](https://affordablehomes.ie/rent/carrigmorewoods/)
### [Warrens Court](https://affordablehomes.ie/rent/warrenscourt/)
#### Status
Coming Soon
#### Location
Barnahely, Co. Cork
[Read More](https://affordablehomes.ie/rent/warrenscourt/)
### [Rath Rua](https://affordablehomes.ie/rent/rathrua1/)
#### Status
Applications Closed
#### Location
Portlaoise, Co. Laois
[Read More](https://affordablehomes.ie/rent/rathrua1/)`;
const L = parseAffordableList(listMd);
const lByT = Object.fromEntries(L.map((e) => [e.title, e]));
ok(L.length === 3, "A: 3 schemes");
ok(lByT["Carrigmore Woods"].open === true, "A: Carrigmore open");
ok(lByT["Warrens Court"].status === "soon", "A: Warrens soon");
ok(lByT["Rath Rua"].status === "closed", "A: Rath Rua closed");
ok(lByT["Carrigmore Woods"].location === "Citywest, Co. Dublin", "A: location parsed");
const d = parseAffordableDetail(`[Apply Now](https://tuathhousing.ie/cost-rental/)
Applications Close:
30 June 2026 at 14:00
### Bedrooms
2 Bed
### Approved Housing Body
Tuath Housing`);
ok(d.beds.includes(2) && d.applyUrl.includes("tuathhousing"), "A: detail beds + apply");
ok(/30 June/.test(d.deadline) && d.provider === "Tuath Housing", "A: detail deadline + provider");
ok(htmlToText(`<h3><a href="https://affordablehomes.ie/rent/x/">Name</a></h3>`).includes("[Name](https://affordablehomes.ie/rent/x/)"), "A: htmlToText keeps links");

// ---------- mocks ----------
const card = (slug, name, status, loc) =>
  `<div><h3><a href="https://affordablehomes.ie/rent/${slug}/">${name}</a></h3>` +
  `<h4>Status</h4><p>${status}</p><h4>Location</h4><p>${loc}</p>` +
  `<a href="https://affordablehomes.ie/rent/${slug}/">Read More</a></div>`;
const detail = (beds) =>
  `<h2>S</h2><a href="https://tuathhousing.ie/cost-rental/">Apply Now</a>` +
  `<h3>Bedrooms</h3><p>${beds}</p><h3>Approved Housing Body</h3><p>Tuath Housing</p>`;
const listingWith = (carrigStatus) =>
  card("carrig", "Carrigmore Woods", carrigStatus, "Citywest, Co. Dublin") +
  card("onebed", "One Bed Place", "Applications Open", "Cork City") +
  card("shut", "Shut Scheme", "Applications Closed", "Galway");

let pages = {};
let sends = [];
let updatesQueue = [];
globalThis.fetch = async (url, opts) => {
  url = String(url);
  if (url.includes("/sendMessage")) { sends.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ ok: true }) }; }
  if (url.includes("/getUpdates")) {
    const m = url.match(/offset=(\d+)/); const off = m ? Number(m[1]) : 0;
    return { ok: true, json: async () => ({ ok: true, result: updatesQueue.filter((u) => u.update_id >= off) }) };
  }
  if (url.startsWith("https://r.jina.ai/")) return { ok: false, status: 404, text: async () => "" };
  const h = pages[url];
  if (h == null) return { ok: false, status: 404, text: async () => "" };
  return { ok: true, status: 200, text: async () => h };
};
const mkStore = () => {
  let schemes = {}, meta = {};
  return {
    async getAll() { return Object.values(schemes); },
    async save(r) { schemes[r.url] = r; },
    async markClosed(open) { for (const r of Object.values(schemes)) if (r.status === "open" && !open.has(r.url)) { r.status = "closed"; r.notified_open = false; } },
    async getMeta() { return meta; },
    async setMeta(m) { meta = m; },
  };
};
const want = new Set([2, 3]);
const recNotify = (t, b) => { sends.push({ text: t, buttons: b }); return true; };

// ---------- B. alert + button + bed filter ----------
pages = { "https://affordablehomes.ie/rent/": listingWith("Applications Open"),
  "https://affordablehomes.ie/rent/carrig/": detail("2 Bed"),
  "https://affordablehomes.ie/rent/onebed/": detail("1 Bed") };
let store = mkStore();
sends = [];
const s1 = await runCycle({ store, notify: recNotify, want, heartbeatHours: 0, listPages: 1 });
ok(s1.ok && s1.open === 2, "B: 2 open schemes detected");
ok(s1.notified.length === 1, "B: exactly 1 alert (2-bed only, not 1-bed)");
ok(sends.length === 1 && /Carrigmore Woods/.test(sends[0].text), "B: alert is for Carrigmore");
ok(/Открыт приём заявок/.test(sends[0].text), "B: alert wording");
const btn = sends[0].buttons?.[0]?.[0];
ok(btn && /Податься/.test(btn.text) && btn.url === "https://tuathhousing.ie/cost-rental/", "B: apply button -> provider URL");

// ---------- C. dedup ----------
sends = [];
const s2 = await runCycle({ store, notify: recNotify, want, heartbeatHours: 0, listPages: 1 });
ok(sends.length === 0 && s2.notified.length === 0, "C: no re-alert on second run");

// ---------- D. re-arm after close then reopen ----------
pages["https://affordablehomes.ie/rent/"] = listingWith("Applications Closed");
sends = [];
await runCycle({ store, notify: recNotify, want, heartbeatHours: 0, listPages: 1 });
ok(sends.length === 0, "D: nothing when Carrigmore closes");
pages["https://affordablehomes.ie/rent/"] = listingWith("Applications Open");
sends = [];
const s4 = await runCycle({ store, notify: recNotify, want, heartbeatHours: 0, listPages: 1 });
ok(sends.length === 1 && /Carrigmore/.test(sends[0].text), "D: re-alert after reopen");

// ---------- E. watchdog ----------
pages = {}; // listing now fails (404 direct + proxy)
let wstore = mkStore();
sends = [];
const w1 = await runCycle({ store: wstore, notify: recNotify, want, heartbeatHours: 0, watchdogAfter: 2, listPages: 1 });
ok(!w1.ok && sends.length === 0, "E: 1st failure -> no alert yet");
sends = [];
const w2 = await runCycle({ store: wstore, notify: recNotify, want, heartbeatHours: 0, watchdogAfter: 2, listPages: 1 });
ok(sends.length === 1 && /Проблема со слежением/.test(sends[0].text), "E: watchdog alert after 2 failures");

// ---------- F. heartbeat ----------
pages = { "https://affordablehomes.ie/rent/": card("shut", "Shut", "Applications Closed", "Galway") };
let hstore = mkStore();
sends = [];
const h1 = await runCycle({ store: hstore, notify: recNotify, want, heartbeatHours: 24, listPages: 1 });
ok(h1.heartbeat && sends.some((s) => /Бот жив/.test(s.text)), "F: heartbeat fires on first run");

// ---------- G. /all command (group + private DM) ----------
pages = { "https://affordablehomes.ie/rent/": listingWith("Applications Open"),
  "https://affordablehomes.ie/rent/carrig/": detail("2 Bed"),
  "https://affordablehomes.ie/rent/onebed/": detail("1 Bed") };
const GROUP = "-100500";
const cstore = mkStore();

// group command
updatesQueue = [{ update_id: 7, message: { chat: { id: GROUP, type: "supergroup" }, text: "/all" } }];
sends = [];
const c1 = await handleCommands({ store: cstore, token: "T", groupChatId: GROUP, adminUserId: null });
ok(c1.handled && sends.length === 1, "G: group /all -> one message");
ok(String(sends[0].chat_id) === GROUP, "G: posted to group");
ok(/Carrigmore Woods/.test(sends[0].text) && /One Bed Place/.test(sends[0].text), "G: lists all open (any size)");
ok(sends[0].reply_markup?.inline_keyboard?.length >= 2, "G: per-scheme buttons present");

// private DM command -> posts to group + confirms privately
updatesQueue = [{ update_id: 9, message: { chat: { id: "555", type: "private" }, from: { id: 555 }, text: "/all" } }];
sends = [];
const c2 = await handleCommands({ store: cstore, token: "T", groupChatId: GROUP, adminUserId: null });
ok(c2.handled, "G: private /all handled");
ok(sends.some((s) => String(s.chat_id) === GROUP), "G: private cmd still posts to GROUP");
ok(sends.some((s) => String(s.chat_id) === "555" && /отправлен в группу/.test(s.text)), "G: private sender gets confirmation");

// no repeat (offset advanced)
updatesQueue = [{ update_id: 9, message: { chat: { id: "555", type: "private" }, from: { id: 555 }, text: "/all" } }];
sends = [];
const c3 = await handleCommands({ store: cstore, token: "T", groupChatId: GROUP, adminUserId: null });
ok(!c3.handled && sends.length === 0, "G: offset respected, no repeat");

// unauthorized private (admin set, different user)
updatesQueue = [{ update_id: 11, message: { chat: { id: "777", type: "private" }, from: { id: 777 }, text: "/all" } }];
sends = [];
const c4 = await handleCommands({ store: cstore, token: "T", groupChatId: GROUP, adminUserId: "555" });
ok(!c4.handled && sends.some((s) => /Не авторизовано/.test(s.text)), "G: admin lock blocks other users");

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "⚠️ FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
