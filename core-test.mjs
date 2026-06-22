// core-test.mjs — full behaviour test for lib/core.mjs (shared by both runtimes).
// Mocks global.fetch (sites + detail pages + Telegram) and uses an in-memory store.

const basePages = {
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

// Mutable mock controls
let ldaOpen = true;
let tuathFails = false;
let tgSends = [];
let fetchCount = {};

globalThis.fetch = async (url, opts) => {
  url = String(url);
  fetchCount[url] = (fetchCount[url] || 0) + 1;
  if (url.includes("api.telegram.org")) {
    tgSends.push(JSON.parse(opts.body).text);
    return { ok: true, json: async () => ({ ok: true }) };
  }
  if (url === "https://tuathhousing.ie/cost-rental/" && tuathFails)
    return { ok: false, status: 503, text: async () => "" };
  let html = basePages[url];
  if (url.endsWith("/lda-cost-rental") && !ldaOpen)
    html = html.replace("APPLICATIONS NOW OPEN", "***APPLICATIONS NOW CLOSED***");
  if (html == null) return { ok: false, status: 404, text: async () => "" };
  return { ok: true, status: 200, text: async () => html };
};

const { runCycle } = await import("./lib/core.mjs");

// In-memory store mirroring both runtime stores.
function makeStore() {
  const schemes = new Map();
  let meta = {};
  return {
    schemes, get meta() { return meta; },
    async getAll() { return [...schemes.values()].map((r) => ({ ...r })); },
    async save(row) { schemes.set(row.url, { ...row }); },
    async markClosed(openUrls) {
      for (const r of schemes.values())
        if (r.status === "open" && !openUrls.has(r.url)) { r.status = "closed"; r.notified_open = false; }
    },
    async getMeta() { return JSON.parse(JSON.stringify(meta)); },
    async setMeta(m) { meta = JSON.parse(JSON.stringify(m)); },
  };
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  ❌", m); } };
const T0 = Date.parse("2026-06-22T09:00:00Z");
const at = (h) => new Date(T0 + h * 3600 * 1000);

// ========== A. alerts / dedupe / re-arm / beds (heartbeat off) ==========
{
  const store = makeStore();
  const base = { store, notify: null, want: new Set([2, 3]), notifyOnUnknown: true, watchdogAfter: 3, heartbeatHours: 0 };
  const notify = (t) => globalThis.fetch("https://api.telegram.org/botX/sendMessage", { body: JSON.stringify({ text: t }) });

  tgSends = [];
  const s1 = await runCycle({ ...base, notify });
  ok(tgSends.length === 3, "A1: fresh cycle -> 3 alerts");
  ok(tgSends.some((t) => t.includes("Open Towers")) && tgSends.some((t) => t.includes("Folkstown")) && tgSends.some((t) => t.includes("River Walk")), "A1: all three sites alerted");
  ok(store.schemes.get("https://tuathhousing.ie/properties/folkstown-park-2/").beds.join() === "2,3", "A2: Tuath beds resolved from detail page (2,3)");
  ok(s1.notified.length === 3 && s1.heartbeat === false, "A2: summary reports 3 notified, no heartbeat");

  fetchCount = {}; tgSends = [];
  await runCycle({ ...base, notify });
  ok(tgSends.length === 0, "A3: unchanged cycle -> 0 alerts (dedupe)");
  ok(!fetchCount["https://tuathhousing.ie/properties/folkstown-park-2/"], "A3: cached beds -> no detail re-fetch");

  ldaOpen = false; tgSends = [];
  await runCycle({ ...base, notify });
  ok(store.schemes.get("https://lda.ie/affordable-homes/lda-cost-rental/open-towers").status === "closed", "A4: closing marks closed");
  ok(store.schemes.get("https://lda.ie/affordable-homes/lda-cost-rental/open-towers").notified_open === false, "A4: re-armed");

  ldaOpen = true; tgSends = [];
  await runCycle({ ...base, notify });
  ok(tgSends.length === 1 && tgSends[0].includes("Open Towers"), "A5: re-opening alerts again (once)");
}

// ========== B. watchdog alert + recovery ==========
{
  ldaOpen = true; tuathFails = true;
  const store = makeStore();
  const notify = (t) => globalThis.fetch("https://api.telegram.org/botX/sendMessage", { body: JSON.stringify({ text: t }) });
  const base = { store, notify, want: new Set([2, 3]), notifyOnUnknown: true, watchdogAfter: 3, heartbeatHours: 0 };

  tgSends = []; await runCycle(base);                 // fail #1
  const wd1 = tgSends.filter((t) => t.includes("Проблема со слежением")).length;
  ok(wd1 === 0, "B1: no watchdog after 1 failure");

  tgSends = []; await runCycle(base);                 // fail #2
  ok(tgSends.filter((t) => t.includes("Проблема")).length === 0, "B2: no watchdog after 2 failures");

  tgSends = []; await runCycle(base);                 // fail #3 -> alert
  ok(tgSends.filter((t) => t.includes("Проблема")).length === 1, "B3: watchdog alert fires on 3rd failure");
  ok(tgSends.some((t) => t.includes("Tuath")), "B3: watchdog names the broken site");

  tgSends = []; await runCycle(base);                 // fail #4 -> no repeat
  ok(tgSends.filter((t) => t.includes("Проблема")).length === 0, "B4: watchdog does not repeat while broken");

  ok(store.schemes.has("https://lda.ie/affordable-homes/lda-cost-rental/open-towers"), "B4: other sites keep working while one is broken");

  tuathFails = false; tgSends = []; await runCycle(base);   // recovers
  ok(tgSends.some((t) => t.includes("снова отвечает")), "B5: recovery message sent");
}

// ========== C. heartbeat throttle ==========
{
  ldaOpen = true; tuathFails = false;
  const store = makeStore();
  const notify = (t) => globalThis.fetch("https://api.telegram.org/botX/sendMessage", { body: JSON.stringify({ text: t }) });
  const base = { store, notify, want: new Set([2, 3]), notifyOnUnknown: true, watchdogAfter: 99, heartbeatHours: 24 };

  tgSends = []; await runCycle({ ...base, now: at(0) });
  ok(tgSends.some((t) => t.includes("Бот жив")), "C1: heartbeat on first cycle");

  tgSends = []; await runCycle({ ...base, now: at(1) });
  ok(!tgSends.some((t) => t.includes("Бот жив")), "C2: no heartbeat 1h later");

  tgSends = []; await runCycle({ ...base, now: at(25) });
  ok(tgSends.some((t) => t.includes("Бот жив")), "C3: heartbeat again after 24h");
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "⚠️  FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
