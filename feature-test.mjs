// feature-test.mjs — proxy markdown parser + listAllSchemes formatting + /all command.
import { extractEntriesFromText, SITES } from "./parser.mjs";
import { formatAllSchemes } from "./lib/core.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  ❌", m); } };

// ===== A. markdown parser on real Tuath structure =====
const tuath = SITES.find((s) => s.name === "Tuath");
const md = `## Cost Rental homes

Launching soon

    					![Thumbnail of Carrigmore Woods](https://x/i.png)

### Carrigmore Woods

Citywest, Dublin 24

[View Details](https://tuathhousing.ie/properties/carrigmore-woods/)

Apply now!

    					![Thumbnail of Rath Rua](https://x/i.png)

### Rath Rua

Portlaoise, Co. Laois

[View Details](https://tuathhousing.ie/properties/rath-rua-2/)

CLOSED

    					![Thumbnail of Folkstown Park](https://x/i.png)

### Folkstown Park

Balbriggan, Co. Dublin

[View Details](https://tuathhousing.ie/properties/folkstown-park-2/)

DÚNTA / CLOSED

    					![Thumbnail of Baker Hall](https://x/i.png)

### Baker Hall

Navan, Co. Meath

[View Details](https://tuathhousing.ie/properties/baker-hall/)`;

const te = extractEntriesFromText(md, tuath.url, tuath.detailPattern);
const byT = Object.fromEntries(te.map((e) => [e.title, e]));
ok(te.length === 4, "A: 4 Tuath schemes parsed from markdown");
ok(byT["Rath Rua"] && tuath.isOpen(byT["Rath Rua"]) === true, "A: Rath Rua OPEN");
ok(byT["Carrigmore Woods"] && tuath.isOpen(byT["Carrigmore Woods"]) === false, "A: Launching soon -> not open");
ok(byT["Folkstown Park"] && tuath.isOpen(byT["Folkstown Park"]) === false, "A: CLOSED");
ok(byT["Baker Hall"] && tuath.isOpen(byT["Baker Hall"]) === false, "A: DÚNTA/CLOSED");
ok(byT["Carrigmore Woods"].location === "Citywest, Dublin 24", "A: location parsed");

// ===== B. formatAllSchemes =====
const sample = [
  { site: "LDA", label: "LDA (lda.ie)", ok: true, schemes: [
    { title: "Open Towers, Dublin 8", location: "", url: "https://lda/x", open: true },
    { title: "Shut Court", location: "", url: "https://lda/y", open: false },
  ]},
  { site: "Tuath", label: "Tuath Housing", ok: true, schemes: [
    { title: "Rath Rua", location: "Portlaoise, Co. Laois", url: "https://t/r", open: true },
  ]},
  { site: "Respond", label: "Respond", ok: false, error: "down", schemes: [] },
];
const txt = formatAllSchemes(sample);
ok(txt.includes("Открыто к подаче: 2"), "B: open count = 2");
ok(txt.includes("Open Towers") && txt.includes("Rath Rua"), "B: lists open schemes");
ok(!txt.includes("Shut Court"), "B: hides closed schemes from main list");
ok(txt.includes("+1 закрытых"), "B: notes closed count");
ok(txt.includes("📍") && /📍[^\n]*Open Towers/.test(txt), "B: Dublin scheme marked 📍");
ok(txt.includes("временно недоступен"), "B: failed site shown as unavailable");

// ===== C. /all command handler (mocked getUpdates + sites) =====
const CHAT = "-100777";
const SITE_HTML = {
  "https://lda.ie/affordable-homes/lda-cost-rental": `<body><h2>Current LDA Cost Rental Schemes</h2>
    <div><h2>Open Towers, Dublin 8</h2><p>APPLICATIONS NOW OPEN</p><p>two-bedroom</p>
    <a href="https://lda.ie/affordable-homes/lda-cost-rental/open-towers"></a></div></body>`,
  "https://tuathhousing.ie/cost-rental/": `<body><h2>Cost Rental homes</h2>
    <div><span>Apply now!</span><h3>Rath Rua</h3><p>Portlaoise</p>
    <a href="https://tuathhousing.ie/properties/rath-rua-2/">View Details</a></div></body>`,
  "https://www.respond.ie/cost-rental/": `<body><h2>Current Listings</h2>
    <div><h3>River Walk, Dublin 24</h3><p>2 and 3 bedroom</p>
    <a href="https://www.respond.ie/properties/river-walk/">View</a></div><h2>Closed Listings</h2></body>`,
};
let tgSends = [];
const updatesQueue = [{ update_id: 5, message: { chat: { id: CHAT }, text: "покажи /all" } }];
globalThis.fetch = async (url, opts) => {
  url = String(url);
  if (url.includes("/getUpdates")) {
    const m = url.match(/offset=(\d+)/);
    const off = m ? Number(m[1]) : 0;
    return { ok: true, json: async () => ({ ok: true, result: updatesQueue.filter((u) => u.update_id >= off) }) };
  }
  if (url.includes("/sendMessage")) { tgSends.push(JSON.parse(opts.body).text); return { ok: true, json: async () => ({ ok: true }) }; }
  const html = SITE_HTML[url];
  if (html == null) return { ok: false, status: 404, text: async () => "" };
  return { ok: true, status: 200, text: async () => html };
};

const { handleCommands } = await import("./lib/commands.mjs");
let meta = {};
const store = {
  async getMeta() { return JSON.parse(JSON.stringify(meta)); },
  async setMeta(m) { meta = JSON.parse(JSON.stringify(m)); },
};

tgSends = [];
const r1 = await handleCommands({ store, token: "T", chatId: CHAT, disabledSites: new Set() });
ok(r1.handled === true, "C: /all handled");
ok(tgSends.length === 1, "C: one reply sent");
ok(tgSends[0].includes("Open Towers") && tgSends[0].includes("Rath Rua") && tgSends[0].includes("River Walk"), "C: reply lists all open schemes from 3 sites");
ok(meta.tgOffset === 6, "C: offset advanced past processed update");

tgSends = [];
const r2 = await handleCommands({ store, token: "T", chatId: CHAT, disabledSites: new Set() });
ok(r2.handled === false && tgSends.length === 0, "C: no repeat on next poll (offset respected)");

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "⚠️ FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
