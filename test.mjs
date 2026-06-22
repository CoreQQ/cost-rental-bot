// test.mjs — validates the parser against fixtures that mirror the real page structure.
import { extractEntries, SITES, bedroomsFromText } from "./parser.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("  ❌", msg); } };

// ---- bedroom parsing ----
ok([...bedroomsFromText("two-bedroom apartments")].includes(2), "two-bedroom -> 2");
ok([...bedroomsFromText("a mix of 1 2 and 3 bedroom apartments")].sort().join() === "1,2,3", "1 2 and 3 -> {1,2,3}");
ok([...bedroomsFromText("3-bed houses")].includes(3), "3-bed -> 3");
ok([...bedroomsFromText("studio, one-bed and two-bed")].sort().join() === "0,1,2", "studio/one/two");
ok([...bedroomsFromText("Balbriggan, Co. Dublin")].length === 0, "location text -> no beds");

// =========================================================================
// LDA fixture — note the trick: status is sometimes its OWN <h2>, placed
// AFTER the scheme name and BEFORE the detail link. Cards use empty anchors.
// =========================================================================
const ldaSite = SITES.find((s) => s.name === "LDA");
const ldaHtml = `<html><body>
  <nav><a href="/affordable-homes">Affordable Homes</a></nav>
  <h2>Current LDA Cost Rental Schemes</h2>

  <div><h2>The Crossings, Adamstown, Co. Dublin</h2>
    <h2>***APPLICATIONS NOW CLOSED***</h2>
    <p>Offering a choice of studios, one-bedroom, two-bedroom, and three-bedroom apartments from &euro;1,024.</p>
    <a href="${ldaSite.url}/the-crossings-adamstown-phase-1"></a></div>

  <div><h2>Riverside Gardens, Dublin 8</h2>
    <p><strong>APPLICATIONS NOW OPEN</strong></p>
    <p>Offering two-bedroom and three-bedroom apartments to rent from &euro;1,500 per month.</p>
    <a href="${ldaSite.url}/riverside-gardens-dublin-8"></a></div>

  <div><h2>Tiny Studios, Dublin 1</h2>
    <p>APPLICATIONS NOW OPEN</p>
    <p>Offering studio and one-bedroom apartments only.</p>
    <a href="${ldaSite.url}/tiny-studios-dublin-1"></a></div>
</body></html>`;

const lda = extractEntries(ldaHtml, ldaSite.url, ldaSite.detailPattern);
console.log("LDA entries:", lda.map((e) => `${e.title} | open=${ldaSite.isOpen(e)} | beds=[${e.cardBeds}]`));
ok(lda.length === 3, "LDA: 3 cards");
const crossings = lda.find((e) => /Crossings/.test(e.title));
ok(crossings && ldaSite.isOpen(crossings) === false, "LDA: Crossings detected CLOSED");
ok(crossings && !/APPLICATIONS/i.test(crossings.title), "LDA: status heading not used as title");
const riverside = lda.find((e) => /Riverside/.test(e.title));
ok(riverside && ldaSite.isOpen(riverside) === true, "LDA: Riverside detected OPEN");
ok(riverside && riverside.cardBeds.includes(2) && riverside.cardBeds.includes(3), "LDA: Riverside beds 2 & 3");

// =========================================================================
// Tuath fixture — status label is a text node placed BEFORE the image/heading.
// Bedroom info is NOT on the card (only on the detail page).
// =========================================================================
const tuathSite = SITES.find((s) => s.name === "Tuath");
const tuathHtml = `<html><body>
  <section><h3>How do I Apply?</h3><p>When applications open you can apply now.</p></section>
  <h2>Cost Rental homes</h2>
  <p>Apply, register your interest for or browse Cost Rental homes.</p>

  <div><span>Apply now!</span><img src="/2-Bed-440x248.jpeg" alt="Thumbnail of Folkstown Park">
    <h3>Folkstown Park</h3><p>Balbriggan, Co. Dublin</p>
    <a href="${tuathSite.url.replace('/cost-rental/','')}/properties/folkstown-park-2/">View Details</a></div>

  <div><span>CLOSED</span><img src="/x.jpg" alt="Thumbnail of Montpelier">
    <h3>Montpelier</h3><p>Dublin 7</p>
    <a href="${tuathSite.url.replace('/cost-rental/','')}/properties/montpelier/">View Details</a></div>

  <div><span>D&Uacute;NTA / CLOSED</span><img src="/y.jpg" alt="Thumbnail of Baker Hall">
    <h3>Baker Hall</h3><p>Navan, Co. Meath</p>
    <a href="${tuathSite.url.replace('/cost-rental/','')}/properties/baker-hall/">View Details</a></div>
</body></html>`;

const tuath = extractEntries(tuathHtml, tuathSite.url, tuathSite.detailPattern);
console.log("Tuath entries:", tuath.map((e) => `${e.title} | open=${tuathSite.isOpen(e)}`));
ok(tuath.length === 3, "Tuath: 3 cards");
const folk = tuath.find((e) => /Folkstown/.test(e.title));
ok(folk && tuathSite.isOpen(folk) === true, "Tuath: Folkstown OPEN (label before heading captured)");
ok(folk && folk.title === "Folkstown Park", "Tuath: correct title");
const mont = tuath.find((e) => /Montpelier/.test(e.title));
ok(mont && tuathSite.isOpen(mont) === false, "Tuath: Montpelier CLOSED");
const baker = tuath.find((e) => /Baker/.test(e.title));
ok(baker && tuathSite.isOpen(baker) === false, "Tuath: Baker Hall DUNTA/CLOSED -> closed");

// =========================================================================
// Respond fixture — open schemes sit under "Current Listings" (above
// "Closed Listings"); card text carries the bedroom mix.
// =========================================================================
const respSite = SITES.find((s) => s.name === "Respond");
const respHtml = `<html><body>
  <h2>Current Listings</h2>
  <div><h3>Maple Court, Dublin 24</h3>
    <p>Maple Court comprises 40 cost rental units, a mix of 2 and 3 bedroom apartments.</p>
    <a href="https://www.respond.ie/properties/maple-court/">View</a></div>

  <h2>Closed Listings</h2>
  <div><h3>Airton Road</h3>
    <p>Airton Road comprises a mix of 1 2 and 3 bedroom apartments.</p>
    <a href="https://www.respond.ie/properties/airton-road/">View</a></div>
  <div><h3>Albert Avenue, Bray</h3>
    <p>Albert Avenue comprises a mix of 1 and 2 bedroom apartments.</p>
    <a href="https://www.respond.ie/properties/albert-avenue-bray/">View</a></div>
</body></html>`;

const resp = extractEntries(respHtml, respSite.url, respSite.detailPattern);
console.log("Respond entries:", resp.map((e) => `${e.title} | open=${respSite.isOpen(e)} | beds=[${e.cardBeds}]`));
ok(resp.length === 3, "Respond: 3 cards");
const maple = resp.find((e) => /Maple/.test(e.title));
ok(maple && respSite.isOpen(maple) === true, "Respond: Maple Court OPEN (above Closed Listings)");
ok(maple && maple.cardBeds.includes(2) && maple.cardBeds.includes(3), "Respond: Maple beds 2 & 3");
const airton = resp.find((e) => /Airton/.test(e.title));
ok(airton && respSite.isOpen(airton) === false, "Respond: Airton CLOSED (below heading)");

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "⚠️  SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
