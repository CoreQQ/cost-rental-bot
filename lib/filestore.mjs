// lib/filestore.mjs — JSON-file-backed store for the standalone runtime.
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";

export function makeFileStore(stateFile) {
  const read = () => {
    if (!existsSync(stateFile)) return { schemes: {}, meta: {} };
    try { return JSON.parse(readFileSync(stateFile, "utf8")); }
    catch { return { schemes: {}, meta: {} }; }
  };
  const data = read();
  data.schemes ||= {};
  data.meta ||= {};
  const write = () => {
    const tmp = stateFile + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, stateFile); // atomic
  };

  return {
    async getAll() { return Object.values(data.schemes); },
    async save(row) { data.schemes[row.url] = row; write(); },
    async markClosed(openUrls) {
      for (const r of Object.values(data.schemes)) {
        if (r.status === "open" && !openUrls.has(r.url)) {
          r.status = "closed";
          r.notified_open = false;
          r.last_seen = new Date().toISOString();
        }
      }
      write();
    },
    async getMeta() { return data.meta; },
    async setMeta(m) { data.meta = m; write(); },
  };
}
