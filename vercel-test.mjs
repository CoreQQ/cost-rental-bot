// vercel-test.mjs — tests the Vercel cycle (runCheck) with an in-memory store + mocked fetch.
const pages = {
  "https://lda.ie/affordable-homes/lda-cost-rental": `<body>
    <h2>Current LDA Cost Rental Schemes</h2>
    <div><h2>Open Towers, Dublin 8</h2><p>APPLICATIONS NOW OPEN</p>
      <p>two-bedroom and three-bedroom apartments</p>
      <a href="https://lda.ie/affordable-homes/lda-cost-rental/open-towers"></a></div>
    <div><h2>Shut Court</h2><h2>***APPLICATIONS NOW CLOSED***</h2><p>two-bedroom</p>
      <a href="https://lda.ie/affordable-homes/lda-cost-rental/shut-court"></a></div>
  </body>`,
  "https://tuathhousing.ie/cost-rental/": `<body><h2>Cost Rental homes</h2>
    <div><span>Apply now!</span><img alt="t"><h3>Folkstown Park</h3><p>Balbriggan</p>
      <a href="https://tuathhousing.ie/properties/folkstown-park-2/">View Details</a></div>
  </body>`,
  "https://www.respond.ie/cost-rental/": `<body>
    <h2>Current Listings</h2>
    <div><h3>River Walk</h3><p>a mix of 2 and 3 bedroom apartments</p>
      <a href="https://www.respond.ie/properties/river-walk/">View</a></div>
    <h2>Closed Listings</h2>
  </body>`,
  "https://tuathhousing.ie/properties/folkstown-park-2/":
    `<body><main>Folkstown Park offers 2 bedroom and 3 bedroom homes.</main></body>`,
};

let ldaOpen = true;
let tgSends = [];
globalThis.fetch = async (url, opts) => {
  url = String(url);
  if (url.includes("api.telegram.org")) {
    tgSends.push(JSON.parse(opts.body).text);
    return { ok: true, json: async () => ({ ok: true }) };
  }
  let html = pages[url];
  if (url.endsWith("/lda-cost-rental") && !ldaOpen)
    html = html.replace("APPLICATIONS NOW OPEN", "***APPLICATIONS NOW CLOSED***");
  if (html == null) return { ok: false, status: 404, text: async () => "" };
  return { ok: true, status: 200, text: async () => html };
};

const { runCheck } = await import("./api/check.js");

// In-memory store mirroring the Supabase store contract.
const db = new Map();
const store = {
  async getAll() { return [...db.values()].map((r) => ({ ...r })); },
  async save(row) { db.set(row.url, { ...row }); },
  async markClosed(openUrls) {
    for (const r of db.values())
      if (r.status === "open" && !openUrls.has(r.url)) { r.status = "closed"; r.notified_open = false; }
  },
};
const opts = { store, notify: (t) => (globalThis.fetch("https://api.telegram.org/botX/sendMessage", { body: JSON.stringify({ text: t }) })), want: new Set([2, 3]), notifyOnUnknown: true };

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  ❌", m); } };

// Cycle 1 — fresh: 3 open 2/3-bed schemes -> 3 alerts
tgSends = [];
let s1 = await runCheck(opts);
console.log("Cycle1:", JSON.stringify(s1.sites), "alerts:", tgSends.length);
ok(tgSends.length === 3, "Cycle1: 3 alerts");
ok(tgSends.some((t) => t.includes("Open Towers")), "Cycle1: LDA alerted");
ok(tgSends.some((t) => t.includes("Folkstown Park")), "Cycle1: Tuath alerted (beds via detail page)");
ok(tgSends.some((t) => t.includes("River Walk")), "Cycle1: Respond alerted");
ok(db.get("https://tuathhousing.ie/properties/folkstown-park-2/").beds.join() === "2,3", "Cycle1: Tuath beds 2,3 cached");

// Cycle 2 — no change: dedupe -> 0 alerts
tgSends = [];
await runCheck(opts);
ok(tgSends.length === 0, "Cycle2: dedupe (0 alerts)");

// Cycle 3 — LDA closes: marked closed + re-armed
ldaOpen = false; tgSends = [];
await runCheck(opts);
ok(db.get("https://lda.ie/affordable-homes/lda-cost-rental/open-towers").status === "closed", "Cycle3: closed");
ok(db.get("https://lda.ie/affordable-homes/lda-cost-rental/open-towers").notified_open === false, "Cycle3: re-armed");

// Cycle 4 — LDA re-opens: alerts again
ldaOpen = true; tgSends = [];
await runCheck(opts);
ok(tgSends.some((t) => t.includes("Open Towers")) && tgSends.length === 1, "Cycle4: re-open alerts again (1)");

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "⚠️  FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
