// filestore-test.mjs — verifies the JSON file store adapter round-trips correctly.
import { rmSync, existsSync, readFileSync } from "node:fs";
import { makeFileStore } from "./lib/filestore.mjs";

const FILE = "./state.filestore-test.json";
if (existsSync(FILE)) rmSync(FILE);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  ❌", m); } };

// Fresh store
let s = makeFileStore(FILE);
ok((await s.getAll()).length === 0, "empty on first use");
ok(JSON.stringify(await s.getMeta()) === "{}", "empty meta on first use");

await s.save({ url: "u1", site: "LDA", title: "A", status: "open", beds: [2, 3], notified_open: true, first_seen: "t", last_seen: "t" });
await s.save({ url: "u2", site: "Tuath", title: "B", status: "open", beds: [2], notified_open: false, first_seen: "t", last_seen: "t" });
await s.setMeta({ fails: { LDA: 1 }, lastHeartbeat: "t0" });
ok(existsSync(FILE), "state file written");

// Reload from disk -> persistence works
let s2 = makeFileStore(FILE);
const all = await s2.getAll();
ok(all.length === 2, "two schemes persisted");
ok(all.find((r) => r.url === "u1").beds.join() === "2,3", "beds persisted");
ok((await s2.getMeta()).fails.LDA === 1, "meta persisted");

// markClosed: only u1 still open -> u2 closed + re-armed
await s2.markClosed(new Set(["u1"]));
let s3 = makeFileStore(FILE);
const m = Object.fromEntries((await s3.getAll()).map((r) => [r.url, r]));
ok(m.u1.status === "open", "u1 stays open");
ok(m.u2.status === "closed" && m.u2.notified_open === false, "u2 closed + re-armed");

rmSync(FILE, { force: true });
console.log(`\n${fail === 0 ? "✅ ALL PASS" : "⚠️  FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
