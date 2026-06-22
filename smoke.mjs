// smoke.mjs — end-to-end runtime test with mocked fetch (no real network/Telegram).
import { writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";

// Env must be set BEFORE importing the bot (module reads it at load time).
process.env.TELEGRAM_BOT_TOKEN = "TEST";
process.env.TELEGRAM_CHAT_ID = "123";
process.env.STATE_FILE = "./state.test.json";
process.env.SEND_STARTUP = "false";
if (existsSync(process.env.STATE_FILE)) rmSync(process.env.STATE_FILE);

// ---- Fixtures served by the mock ----
const pages = {
  "https://lda.ie/affordable-homes/lda-cost-rental": `<body>
    <h2>Current LDA Cost Rental Schemes</h2>
    <div><h2>Open Towers, Dublin 8</h2><p>APPLICATIONS NOW OPEN</p>
      <p>two-bedroom and three-bedroom apartments</p>
      <a href="https://lda.ie/affordable-homes/lda-cost-rental/open-towers"></a></div>
    <div><h2>Shut Court, Dublin 9</h2><h2>***APPLICATIONS NOW CLOSED***</h2>
      <p>two-bedroom apartments</p>
      <a href="https://lda.ie/affordable-homes/lda-cost-rental/shut-court"></a></div>
  </body>`,
  "https://tuathhousing.ie/cost-rental/": `<body>
    <h2>Cost Rental homes</h2>
    <div><span>Apply now!</span><img alt="t"><h3>Folkstown Park</h3><p>Balbriggan</p>
      <a href="https://tuathhousing.ie/properties/folkstown-park-2/">View Details</a></div>
    <div><span>CLOSED</span><img alt="t"><h3>Old Mill</h3><p>Navan</p>
      <a href="https://tuathhousing.ie/properties/old-mill/">View Details</a></div>
  </body>`,
  "https://www.respond.ie/cost-rental/": `<body>
    <h2>Current Listings</h2>
    <div><h3>River Walk</h3><p>a mix of 2 and 3 bedroom apartments</p>
      <a href="https://www.respond.ie/properties/river-walk/">View</a></div>
    <h2>Closed Listings</h2>
    <div><h3>Old Place</h3><p>a mix of 1 and 2 bedroom apartments</p>
      <a href="https://www.respond.ie/properties/old-place/">View</a></div>
  </body>`,
  // Detail page for Tuath Folkstown (beds not on card -> resolved here)
  "https://tuathhousing.ie/properties/folkstown-park-2/": `<body><main>
    Folkstown Park offers 2 bedroom and 3 bedroom homes.</main></body>`,
};

let telegramSends = [];
let varyShutCourt = false; // toggled to simulate Open Towers closing later

globalThis.fetch = async (url, opts) => {
  url = String(url);
  if (url.includes("api.telegram.org")) {
    const body = JSON.parse(opts.body);
    if (url.includes("/sendMessage")) telegramSends.push(body.text);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
  }
  // simulate Open Towers disappearing from open list on later cycles
  let html = pages[url];
  if (url === "https://lda.ie/affordable-homes/lda-cost-rental" && varyShutCourt) {
    html = html.replace("APPLICATIONS NOW OPEN", "***APPLICATIONS NOW CLOSED***");
  }
  if (html == null) return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
  return { ok: true, status: 200, text: async () => html, json: async () => ({}) };
};

const { runCycle } = await import("./cost-rental-bot.mjs");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  ❌", m); } };

// ---- Cycle 1: fresh -> should alert the 3 open 2/3-bed schemes ----
let state = { schemes: {} };
telegramSends = [];
await runCycle(state);
console.log(`Cycle 1 sent ${telegramSends.length} alerts`);
ok(telegramSends.length === 3, "Cycle1: 3 alerts (Open Towers, Folkstown, River Walk)");
ok(telegramSends.some((t) => t.includes("Open Towers")), "Cycle1: LDA Open Towers alerted");
ok(telegramSends.some((t) => t.includes("Folkstown Park")), "Cycle1: Tuath Folkstown alerted");
ok(telegramSends.some((t) => t.includes("River Walk")), "Cycle1: Respond River Walk alerted");
ok(!telegramSends.some((t) => t.includes("Shut Court") || t.includes("Old Mill") || t.includes("Old Place")),
   "Cycle1: closed schemes NOT alerted");
ok(state.schemes["https://tuathhousing.ie/properties/folkstown-park-2/"].beds.join() === "2,3",
   "Cycle1: Tuath beds resolved from detail page (2,3)");

// ---- Cycle 2: nothing changed -> no duplicate alerts ----
telegramSends = [];
await runCycle(state);
console.log(`Cycle 2 sent ${telegramSends.length} alerts`);
ok(telegramSends.length === 0, "Cycle2: no duplicate alerts (dedupe works)");

// ---- Cycle 3: Open Towers closes -> marked closed + re-armed ----
varyShutCourt = true;
telegramSends = [];
await runCycle(state);
ok(state.schemes["https://lda.ie/affordable-homes/lda-cost-rental/open-towers"].status === "closed",
   "Cycle3: Open Towers marked closed");
ok(state.schemes["https://lda.ie/affordable-homes/lda-cost-rental/open-towers"].notifiedOpen === false,
   "Cycle3: Open Towers re-armed for next opening");
ok(telegramSends.length === 0, "Cycle3: closing produces no alert");

// ---- Cycle 4: Open Towers re-opens -> alerts again ----
varyShutCourt = false;
telegramSends = [];
await runCycle(state);
ok(telegramSends.some((t) => t.includes("Open Towers")), "Cycle4: re-opening alerts again");
ok(telegramSends.length === 1, "Cycle4: only the re-opened scheme alerts");

rmSync(process.env.STATE_FILE, { force: true });
console.log(`\n${fail === 0 ? "✅ ALL PASS" : "⚠️  SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
