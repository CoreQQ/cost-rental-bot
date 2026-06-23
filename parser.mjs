// parser.mjs
// Robust, structure-tolerant parsing of the three cost-rental listing pages.
// The pages are server-rendered, so a plain GET + cheerio is enough (no headless browser).
//
// Strategy (works even if CSS class names change):
//   1. Find every <a> whose href points at a scheme detail page (per-site URL pattern).
//   2. Treat the links as card delimiters: card_i spans (prevLink, thisLink].
//   3. Title  = nearest preceding "real" heading (status/section headings filtered out).
//   4. Status = decided per-site from the card's text (LDA/Tuath) or section position (Respond).
//   5. Bedrooms = parsed from the card text; if absent, the runtime fetches the detail page.

import { load } from "cheerio";

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

function absolute(base, href) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

const WORD2NUM = { studio: 0, one: 1, two: 2, three: 3, four: 4, five: 5 };

// Pull every bedroom count mentioned in a chunk of text.
// Handles: "2 bed", "2-bed", "2 bedroom(s)", "two-bedroom", "1, 2 and 3 bedroom", "2x 2 bedroom", "studio".
export function bedroomsFromText(text) {
  const t = (text || "").toLowerCase();
  const found = new Set();
  if (/\bstudio\b/.test(t)) found.add(0);
  for (const m of t.matchAll(/(\d+)\s*-?\s*bed(?:room)?s?\b/g)) found.add(Number(m[1]));
  for (const m of t.matchAll(/\b(one|two|three|four|five)\s*-?\s*bed(?:room)?s?\b/g)) {
    if (m[1] in WORD2NUM) found.add(WORD2NUM[m[1]]);
  }
  // lists like "1 2 and 3 bedroom"
  const list = t.match(/((?:\d+[\s,]+){1,}(?:and\s+)?\d+)\s*-?\s*bed(?:room)?/);
  if (list) for (const d of list[1].matchAll(/\d+/g)) found.add(Number(d[0]));
  found.delete(NaN);
  return found;
}

// Headings that are NOT scheme names (status labels, section titles, boilerplate).
const NON_TITLE = [
  /^applications?\b/i, /\bclosed\b/i, /^apply now/i, /^coming soon/i,
  /current listings/i, /closed listings/i, /d[uú]nta/i,
  /frequently asked/i, /^what is cost rental/i, /^how do i apply/i,
  /^am i eligible/i, /^cost rental homes?$/i, /current lda cost rental schemes/i,
  /^find out more/i, /^security you can count on/i, /^transparent/i,
  /^affordability/i, /^quality without/i, /^current listings/i, /^eligibility/i,
];
const isStatusHeading = (text) => NON_TITLE.some((re) => re.test(text));

/**
 * Extract scheme entries from a listing page.
 * @returns {Array<{title, url, text, linkPos, closedListingsPos, cardBeds:number[]}>}
 */
export function extractEntries(html, baseUrl, detailPattern) {
  const $ = load(html);
  $("script, style, noscript").remove();
  const root = $("body").length ? $("body") : $.root();

  const els = root.find("*").toArray();
  const posOf = new Map();
  els.forEach((el, i) => posOf.set(el, i));
  const ownText = (el) =>
    clean($(el).contents().filter((_, n) => n.type === "text").text());

  // All headings, with positions.
  const headings = els
    .filter((el) => /^h[1-6]$/.test((el.tagName || "").toLowerCase()))
    .map((el) => ({ pos: posOf.get(el), text: clean($(el).text()) }))
    .filter((h) => h.text);

  const titleHeadings = headings.filter((h) => !isStatusHeading(h.text));
  const closedListingsPos =
    headings.find((h) => /closed listings/i.test(h.text))?.pos ?? Infinity;

  // Detail links (dedupe by URL without trailing slash; keep first occurrence).
  const baseKey = baseUrl.replace(/\/+$/, "");
  const seen = new Set();
  const links = [];
  $("a[href]").each((_, a) => {
    const raw = $(a).attr("href") || "";
    if (!raw.includes(detailPattern)) return;
    const abs = absolute(baseUrl, raw);
    if (!abs) return;
    const key = abs.replace(/\/+$/, "");
    if (key === baseKey) return;          // the listing page itself
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ pos: posOf.get(a), href: abs });
  });
  links.sort((a, b) => a.pos - b.pos);
  if (links.length === 0) return [];

  const lastTitleBefore = (limit, floor) => {
    let best = null;
    for (const h of titleHeadings) {
      if (h.pos < limit && h.pos >= floor && (!best || h.pos > best.pos)) best = h;
    }
    return best;
  };

  const textBetween = (start, end) => {
    const out = [];
    for (const el of els) {
      const p = posOf.get(el);
      if (p < start || p >= end) continue;
      const t = ownText(el);
      if (t) out.push(t);
    }
    return out.join(" ");
  };

  // Section start: just before the first card's heading, with a small bounded
  // look-back so a status label sitting *above* the first card heading is captured
  // (Tuath puts "Apply now!"/"CLOSED" before the heading) without reaching page intro.
  const firstTitle = lastTitleBefore(links[0].pos, 0);
  const sectionStart = Math.max(0, (firstTitle ? firstTitle.pos : links[0].pos) - 6);

  const entries = [];
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const start = i === 0 ? sectionStart : links[i - 1].pos + 1;
    const end = link.pos + 1;
    const titleH = lastTitleBefore(link.pos, start);
    const title = titleH ? titleH.text : "Без названия";
    const text = textBetween(start, end);
    entries.push({
      title,
      url: link.href,
      text,
      linkPos: link.pos,
      closedListingsPos,
      cardBeds: [...bedroomsFromText(text)],
    });
  }
  return entries;
}

// ---- Site definitions ----------------------------------------------------
export const SITES = [
  {
    name: "LDA",
    label: "LDA (lda.ie)",
    url: "https://lda.ie/affordable-homes/lda-cost-rental",
    detailPattern: "/affordable-homes/lda-cost-rental/",
    // Open unless the card carries a "closed" marker.
    isOpen: (e) =>
      !/applications?\s+now\s+closed|applications?\s+closed|\bclosed\b/i.test(e.text),
  },
  {
    name: "Tuath",
    label: "Tuath Housing (tuathhousing.ie)",
    url: "https://tuathhousing.ie/cost-rental/",
    detailPattern: "/properties/",
    // Per-card label; "closed" wins to stay safe against a stray top "Apply now" button.
    isOpen: (e) =>
      /\bapply now\b/i.test(e.text) && !/\bclosed\b|d[uú]nta/i.test(e.text),
  },
  {
    name: "Respond",
    label: "Respond (respond.ie)",
    url: "https://www.respond.ie/cost-rental/",
    detailPattern: "/properties/",
    // Open schemes are listed ABOVE the "Closed Listings" heading.
    isOpen: (e) => e.linkPos < e.closedListingsPos,
  },
];

// ---- Loose text/markdown parser (for the render-proxy fallback) -----------
// Render proxies (e.g. Jina Reader) return markdown, not HTML, so cheerio finds
// nothing. This walks the text by detail-link, mirroring extractEntries' logic.
export function extractEntriesFromText(text, baseUrl, detailPattern) {
  const lines = (text || "").split(/\r?\n/);
  const esc = detailPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reUrl = new RegExp(`https?:\\/\\/[^\\s)"'<>]*${esc}[^\\s)"'<>]*`);
  const baseKey = baseUrl.replace(/\/+$/, "");

  let closedListingsPos = Infinity;
  for (let i = 0; i < lines.length; i++) {
    if (/closed listings/i.test(lines[i])) { closedListingsPos = i; break; }
  }

  const hits = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(reUrl);
    if (!m) continue;
    const url = m[0].replace(/[)\].,"'>]+$/, "");
    const key = url.replace(/\/+$/, "");
    if (key === baseKey || seen.has(key)) continue;
    seen.add(key);
    hits.push({ line: i, url });
  }

  const isHeading = (l) => /^#{2,4}\s+/.test(l.trim());
  const entries = [];
  for (let k = 0; k < hits.length; k++) {
    const hit = hits[k];
    const start = k === 0 ? Math.max(0, hit.line - 12) : hits[k - 1].line + 1;
    const win = lines.slice(start, hit.line + 1);
    const winText = win.join("\n");
    const headings = win.filter(isHeading);
    let title = "Без названия";
    let location = "";
    if (headings.length) {
      const h = headings[headings.length - 1];
      title = h.trim().replace(/^#{2,4}\s+/, "").trim();
      for (let j = win.lastIndexOf(h) + 1; j < win.length; j++) {
        const l = win[j].trim();
        if (!l || isHeading(win[j]) || /^!\[/.test(l) || /\]\(/.test(l) || /^https?:/.test(l)) continue;
        location = l.replace(/[*_`]+/g, "").trim();
        break;
      }
    }
    entries.push({
      title, location, url: hit.url, text: winText, linkPos: hit.line,
      closedListingsPos, cardBeds: [...bedroomsFromText(winText)],
    });
  }
  return entries;
}
