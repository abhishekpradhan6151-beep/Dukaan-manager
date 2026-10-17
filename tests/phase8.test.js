/*
 * Dukaan Manager Phase 8 browser tests (Playwright + Chromium).
 *
 *   NODE_PATH=/path/to/node_modules node tests/phase8.test.js
 *   PHASE7_DIR=/path/to/unzipped/phase7/folder  (optional: enables the Phase 7 -> 8 upgrade test)
 *
 * Every test group opens a brand-new browser context, so it has its own throw-away IndexedDB.
 * Real data in your own browser is never touched. The app is served from a tiny local server.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PHASE7 = process.env.PHASE7_DIR || "";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml" };
const srv = { root: ROOT };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const f = path.join(srv.root, p);
  if (!f.startsWith(srv.root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
  res.end(fs.readFileSync(f));
});

/* ---------- tiny test runner ---------- */
const results = [];
const allErrors = [];
async function test(id, name, fn) {
  try { await fn(); results.push({ id, name, status: "PASS" }); console.log("PASS     " + id + "  " + name); }
  catch (e) { results.push({ id, name, status: "FAIL", detail: e.message }); console.log("FAIL     " + id + "  " + name + "\n         -> " + e.message); }
}
function blocked(id, name, why) { results.push({ id, name, status: "BLOCKED", detail: why }); console.log("BLOCKED  " + id + "  " + name + "\n         -> " + why); }
const ok = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };
const eq = (a, b, m) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error((m || "mismatch") + ": got " + x + ", expected " + y); };

/* ---------- page helpers ---------- */
let base = "";
async function openApp(browser, opts) {
  opts = opts || {};
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.errs = [];
  page.on("pageerror", (e) => page.errs.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") page.errs.push("console: " + m.text()); });
  page.on("requestfailed", (r) => page.errs.push("requestfailed: " + r.url()));
  page.on("response", (r) => { if (r.status() >= 400) page.errs.push("http " + r.status() + ": " + r.url()); });
  allErrors.push({ page });
  await page.goto(base + "/index.html");
  await ready(page);
  return { context, page };
}
const ready = (page) => page.waitForFunction(() => {
  const s = window.DukaanProducts && DukaanProducts.stats();
  return s && !s.failed && DukaanSales.status() === "ready" && DukaanLedger.status() === "ready" && DukaanExpenses.status() === "ready";
}, null, { timeout: 15000 });

const rawAll = (page, store) => page.evaluate((s) => new Promise((res, rej) => {
  const o = indexedDB.open("dukaan-manager");
  o.onerror = () => rej(o.error);
  o.onsuccess = () => { const db = o.result; const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => { db.close(); res(q.result); }; q.onerror = () => rej(q.error); };
}), store);
const rawWrite = (page, store, op, rec) => page.evaluate((a) => new Promise((res, rej) => {
  const o = indexedDB.open("dukaan-manager");
  o.onerror = () => rej(o.error);
  o.onsuccess = () => { const db = o.result; const tx = db.transaction(a.store, "readwrite"); const st = tx.objectStore(a.store); if (a.op === "put") st.put(a.rec); else st.delete(a.rec); tx.oncomplete = () => { db.close(); res(true); }; tx.onerror = () => rej(tx.error); };
}), { store, op, rec });
const rawDbVersion = (page) => page.evaluate(() => new Promise((res) => { const o = indexedDB.open("dukaan-manager"); o.onsuccess = () => { const v = o.result.version; o.result.close(); res(v); }; }));

const product = async (page, name) => (await rawAll(page, "products")).find((p) => p.name === name);
const history = async (page, pid) => (await rawAll(page, "stockHistory")).filter((h) => h.productId === pid);
const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForSelector("#view-" + hash.slice(1) + ":not([hidden])"); };
const closeDialogs = (page) => page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => d.close()));
const toastText = (page) => page.evaluate(() => document.getElementById("toast").textContent);
const waitToast = (page, re) => page.waitForFunction((s) => new RegExp(s).test(document.getElementById("toast").textContent) && !document.getElementById("toast").hidden, re.source, { timeout: 8000 });
const settle = (page) => page.evaluate(() => DukaanProducts.refresh());
const alertRows = (page) => page.$$eval("#alList table tbody tr", (trs) => trs.map((tr) => {
  const td = Array.from(tr.children).map((c) => c.innerText.trim());
  return { name: td[0].split("\n")[0], stock: td[1], level: td[2], status: td[3] };
}));
const dash = (page) => page.$$eval("#cardsStock .card", (cs) => Object.fromEntries(cs.map((c) => [c.querySelector(".card-label").textContent, c.querySelector(".card-value").textContent])));
const uid = (page) => page.evaluate(() => DukaanDB.uid());

async function addProduct(page, p) {
  await go(page, "#products");
  await page.click("#pAdd");
  await page.fill("#fName", p.name);
  if (p.unit) await page.selectOption("#fUnit", p.unit);
  await page.fill("#fCost", String(p.cost));
  await page.fill("#fPrice", String(p.price));
  await page.fill("#fOpening", String(p.opening));
  if (p.low !== undefined) await page.fill("#fLow", String(p.low));
  await page.click("#pdSave");
  await page.waitForFunction((n) => !document.getElementById("productDialog").open && DukaanProducts.list().some((x) => x.name === n), p.name);
  return product(page, p.name);
}
async function openAdjust(page, id, f) {
  await page.evaluate((i) => DukaanProducts.openAdjust(i), id);
  await page.selectOption("#aDir", f.dir || "add");
  await page.fill("#aQty", f.qty);
  if (f.reason) await page.selectOption("#aReason", f.reason);
  if (f.note) await page.fill("#aNote", f.note);
}
async function adjustUI(page, id, f) { // a full, successful adjustment through the dialog
  await openAdjust(page, id, f);
  await page.click("#adSave");
  await page.waitForFunction(() => !document.getElementById("adjustDialog").open);
  await settle(page);
}
async function saleUI(page, name, qty) {
  await go(page, "#sale");
  await page.fill("#sSearch", name);
  await page.click("#sResults button[data-add]");
  if (qty !== 1) { const inp = page.locator("#sCart .qty-input").first(); await inp.fill(String(qty)); await inp.press("Tab"); }
  const before = await page.evaluate(() => DukaanSales.cached().length);
  await page.click("#sComplete");
  await page.waitForFunction((n) => DukaanSales.cached().length === n + 1, before);
  await page.waitForFunction(() => DukaanProducts.list().length > 0);
  await settle(page);
  const sale = await page.evaluate(() => DukaanSales.cached()[0]);
  await closeDialogs(page);
  return sale;
}
async function cancelUI(page, saleId) {
  await page.evaluate((id) => DukaanHistory.showSale(id), saleId);
  await page.click("#sdCancel");
  await page.fill("#cReason", "test cancel");
  await page.click("#cConfirm");
  await waitToast(page, /Sale cancelled/);
  await closeDialogs(page);
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  base = "http://localhost:" + server.address().port;
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  console.log("Serving " + ROOT + " at " + base + "\n");

  /* =====================================================================
   * GROUP A: alerts and stock adjustments (one isolated browser profile)
   * ===================================================================== */
  const A = await openApp(browser);
  const a = A.page;
  let P1, P2;

  await test("T1", "Set and save a product's minimum-stock threshold", async () => {
    await go(a, "#products");
    await a.click("#pAdd");
    eq(await a.inputValue("#fLow"), "5", "new product form should suggest the default level");
    const hint = await a.textContent("#lowHint");
    ok(/no level saved use 5/.test(hint), "the default must be explained in the form: " + hint);
    await a.click("#pdCancel");

    P1 = await addProduct(a, { name: "Rice Pack", unit: "packet", cost: 40, price: 50, opening: 20, low: 10 });
    eq(P1.lowStockThreshold, 10, "threshold saved in IndexedDB on create");
    P2 = await addProduct(a, { name: "Loose Sugar", unit: "kg", cost: 30, price: 40, opening: 12.5, low: 3 });
    eq(P2.lowStockThreshold, 3);

    // edit: the alert-level field is prefilled and saves
    await a.evaluate((id) => DukaanProducts.openEdit(id, "fLow"), P1.id);
    eq(await a.inputValue("#fLow"), "10");
    eq(await a.evaluate(() => document.activeElement.id), "fLow", "Edit alert level should focus the level field");
    await a.fill("#fLow", "12");
    await a.click("#pdSave");
    await a.waitForFunction(() => !document.getElementById("productDialog").open);
    eq((await product(a, "Rice Pack")).lowStockThreshold, 12, "edited threshold saved");
    eq((await product(a, "Rice Pack")).stock, 20, "editing the level must not change stock");
    // invalid values are refused and nothing is saved
    for (const bad of ["abc", "-1", "2.5", "", "1e2"]) {
      await a.evaluate((id) => DukaanProducts.openEdit(id), P1.id);
      await a.fill("#fLow", bad);
      await a.click("#pdSave");
      ok((await a.textContent("#e-fLow")).length > 0, "no error shown for level '" + bad + "'");
      ok(await a.evaluate(() => document.getElementById("productDialog").open), "dialog should stay open for '" + bad + "'");
      await a.click("#pdCancel");
    }
    eq((await product(a, "Rice Pack")).lowStockThreshold, 12, "bad values must not change the saved level");
    // decimal level is fine for a kg product
    await a.evaluate((id) => DukaanProducts.openEdit(id), P2.id);
    await a.fill("#fLow", "2.5");
    await a.click("#pdSave");
    await a.waitForFunction(() => !document.getElementById("productDialog").open);
    eq((await product(a, "Loose Sugar")).lowStockThreshold, 2.5);
    // put the working values back
    await a.evaluate((id) => DukaanProducts.openEdit(id), P1.id); await a.fill("#fLow", "10"); await a.click("#pdSave");
    await a.waitForFunction(() => !document.getElementById("productDialog").open);
    await a.evaluate((id) => DukaanProducts.openEdit(id), P2.id); await a.fill("#fLow", "3"); await a.click("#pdSave");
    await a.waitForFunction(() => !document.getElementById("productDialog").open);
    eq((await product(a, "Rice Pack")).lowStockThreshold, 10);
    eq((await product(a, "Loose Sugar")).lowStockThreshold, 3);
  });

  await test("T2", "Low-stock alert appears exactly at the threshold", async () => {
    // stock 20, level 10. At 11 there is no alert.
    await adjustUI(a, P1.id, { dir: "remove", qty: "9", reason: "Damaged" });
    eq((await product(a, "Rice Pack")).stock, 11);
    await go(a, "#alerts");
    eq((await alertRows(a)).filter((r) => r.name === "Rice Pack").length, 0, "no alert at 11 (level 10)");
    // at exactly 10 it alerts
    await adjustUI(a, P1.id, { dir: "remove", qty: "1", reason: "Damaged" });
    const rows = (await alertRows(a)).filter((r) => r.name === "Rice Pack");
    eq(rows.length, 1, "one alert at stock == level");
    eq(rows[0].status, "Low stock");
    eq(rows[0].stock, "10 packet");
    eq(rows[0].level, "10 packet");
    const d = await dash(a);
    eq(d["Low stock"], "1", "dashboard low-stock count");
    eq(d["Out of stock"], "0", "dashboard out-of-stock count");
    // decimal product: level 3, stock 12.5 -> 3 alerts, 3.001 does not
    await adjustUI(a, P2.id, { dir: "remove", qty: "9.5", reason: "Count correction" });
    eq((await alertRows(a)).filter((r) => r.name === "Loose Sugar")[0].status, "Low stock");
    await adjustUI(a, P2.id, { dir: "add", qty: "0.001", reason: "Count correction" });
    eq((await alertRows(a)).filter((r) => r.name === "Loose Sugar").length, 0, "3.001 kg is above level 3");
    await adjustUI(a, P2.id, { dir: "remove", qty: "0.001", reason: "Count correction" });
    eq((await alertRows(a)).filter((r) => r.name === "Loose Sugar").length, 1, "back to exactly 3 kg");
  });

  await test("T3", "Out-of-stock status appears at zero and is separate from low stock", async () => {
    await adjustUI(a, P1.id, { dir: "remove", qty: "10", reason: "Lost or stolen" });
    eq((await product(a, "Rice Pack")).stock, 0);
    const row = (await alertRows(a)).find((r) => r.name === "Rice Pack");
    eq(row.status, "Out of stock");
    const d = await dash(a);
    eq(d["Out of stock"], "1", "out-of-stock count");
    eq(d["Low stock"], "1", "only Loose Sugar is low; zero stock is not counted as low");
    // the two badges look different (text and colour class)
    const cls = await a.$$eval("#alList table tbody tr", (trs) => trs.map((tr) => ({ n: tr.children[0].innerText.split("\n")[0], c: tr.querySelector(".badge").className })));
    ok(cls.find((r) => r.n === "Rice Pack").c.includes("out"), "out badge class");
    ok(cls.find((r) => r.n === "Loose Sugar").c.includes("credit") && !cls.find((r) => r.n === "Loose Sugar").c.includes("out"), "low badge class");
    // out-of-stock is listed before low stock
    eq((await alertRows(a)).map((r) => r.name), ["Rice Pack", "Loose Sugar"], "out of stock listed first");
    // the Products page badge says Out of stock too
    await go(a, "#products");
    ok((await a.textContent("#pList")).includes("Out of stock"), "Products page shows Out of stock");
  });

  await test("T4", "Alert disappears when stock rises above the threshold", async () => {
    await adjustUI(a, P1.id, { dir: "add", qty: "10", reason: "Stock received (purchase)" });
    await go(a, "#alerts");
    eq((await alertRows(a)).find((r) => r.name === "Rice Pack").status, "Low stock", "10 == level: still an alert, now Low not Out");
    await adjustUI(a, P1.id, { dir: "add", qty: "1", reason: "Stock received (purchase)" });
    eq((await alertRows(a)).filter((r) => r.name === "Rice Pack").length, 0, "11 > 10: alert removed");
    await adjustUI(a, P2.id, { dir: "add", qty: "10", reason: "Stock received (purchase)" });
    eq(await a.evaluate(() => DukaanAlerts.rows().length), 0, "no alerts left");
    ok((await a.textContent("#alList")).includes("No stock alerts"), "empty state text");
    const d = await dash(a);
    eq([d["Low stock"], d["Out of stock"]], ["0", "0"]);
  });

  await test("X1", "Archived products never show alerts; restoring brings them back", async () => {
    await adjustUI(a, P1.id, { dir: "remove", qty: "11", reason: "Damaged" }); // stock 0
    await go(a, "#alerts");
    eq((await alertRows(a)).length, 1);
    await a.evaluate(() => { location.hash = "#products"; });
    // archive through the detail dialog
    await a.evaluate((id) => { document.querySelector('#pList button[data-act="view"][data-id="' + id + '"]').click(); }, P1.id);
    await a.waitForSelector("#detailDialog[open]");
    await a.click("#dtArchive");
    await a.click("#askOk");
    await a.waitForFunction((id) => DukaanProducts.list().find((p) => p.id === id).status === "archived", P1.id);
    await settle(a);
    await closeDialogs(a);
    eq(await a.evaluate(() => DukaanAlerts.rows().length), 0, "archived out-of-stock product is not an alert");
    const d = await dash(a);
    eq([d["Low stock"], d["Out of stock"]], ["0", "0"], "dashboard ignores archived products");
    await a.evaluate((id) => DukaanProducts.openAdjust(id), P1.id);
    eq(await a.evaluate(() => document.getElementById("adjustDialog").open), false, "archived product cannot be adjusted");
    await a.evaluate(async (id) => { await DukaanDB.run(["products"], "readwrite", async (tx) => { const s = tx.objectStore("products"); const p = await DukaanDB.req(s.get(id)); p.status = "active"; s.put(p); }); await DukaanProducts.refresh(); }, P1.id);
    eq(await a.evaluate(() => DukaanAlerts.rows().map((r) => r.name)), ["Rice Pack"], "restored product alerts again");
    await adjustUI(a, P1.id, { dir: "add", qty: "20", reason: "Stock received (purchase)" }); // stock 20, no alert
  });

  await test("X2", "Search and filters on the alert list", async () => {
    // make both products alert: Rice 20 -> 4 (low), Sugar 13 -> 0 (out)
    await adjustUI(a, P1.id, { dir: "remove", qty: "16", reason: "Damaged" });
    await adjustUI(a, P2.id, { dir: "remove", qty: "13", reason: "Expired" });
    await go(a, "#alerts");
    eq((await alertRows(a)).length, 2);
    await a.fill("#alSearch", "rice");
    eq((await alertRows(a)).map((r) => r.name), ["Rice Pack"]);
    await a.fill("#alSearch", "zzz");
    ok((await a.textContent("#alList")).includes("No alerts match"), "no-match state");
    await a.fill("#alSearch", "");
    await a.selectOption("#alStatus", "out");
    eq((await alertRows(a)).map((r) => r.name), ["Loose Sugar"], "out-only filter");
    await a.selectOption("#alStatus", "low");
    eq((await alertRows(a)).map((r) => r.name), ["Rice Pack"], "low-only filter");
    await a.selectOption("#alStatus", "all");
    const cats = await a.$$eval("#alCategory option", (o) => o.map((x) => x.value));
    ok(cats.includes("General"), "category filter lists categories");
    await a.selectOption("#alCategory", "General");
    eq((await alertRows(a)).length, 2);
    await a.selectOption("#alCategory", "");
    ok(/2 alerts shown \(of 2\)/.test(await a.textContent("#alCount")), "count line: " + await a.textContent("#alCount"));
    // row buttons open the adjust dialog and the level editor
    await a.click('#alList table button[data-act="adjust"][data-id="' + P1.id + '"]');
    ok(await a.evaluate(() => document.getElementById("adjustDialog").open), "Adjust stock button opens the dialog");
    ok((await a.textContent("#adTitle")).includes("Rice Pack"));
    await a.click("#adCancel");
    await a.click('#alList table button[data-act="level"][data-id="' + P1.id + '"]');
    eq(await a.evaluate(() => document.activeElement.id), "fLow");
    await a.click("#pdCancel");
  });

  await test("T5", "Alerts update automatically after a sale and after its cancellation", async () => {
    // Rice is 4 (low). Add 8 to get 12 (no alert), then sell 3 -> 9 (low alert), cancel -> 12 (alert gone).
    await adjustUI(a, P1.id, { dir: "add", qty: "8", reason: "Stock received (purchase)" });
    eq((await product(a, "Rice Pack")).stock, 12);
    const before = (await alertRows(a)).length; // page is not even open: alerts must still be right when opened
    const sale = await saleUI(a, "Rice", 3);
    eq((await product(a, "Rice Pack")).stock, 9, "sale reduced stock once");
    eq((await history(a, P1.id)).filter((h) => h.type === "sale").length, 1, "exactly one sale stock entry");
    await go(a, "#alerts");
    eq((await alertRows(a)).filter((r) => r.name === "Rice Pack")[0].status, "Low stock", "alert appears after the sale");
    eq((await dash(a))["Low stock"], "1", "dashboard updated after the sale");
    // cancel while the Alerts page is open and watch it change without any reload
    await cancelUI(a, sale.id);
    eq((await product(a, "Rice Pack")).stock, 12, "cancellation returned stock once");
    eq((await alertRows(a)).filter((r) => r.name === "Rice Pack").length, 0, "alert removed after the cancellation");
    eq((await history(a, P1.id)).filter((h) => h.type === "sale-cancel").length, 1, "exactly one cancel stock entry");
    // a second cancel (also two at once) is refused and stock does not move again
    const res = await a.evaluate((id) => Promise.allSettled([DukaanSales.cancel(id, "again one"), DukaanSales.cancel(id, "again two")]).then((r) => r.map((x) => x.status)), sale.id);
    eq(res, ["rejected", "rejected"], "both extra cancels refused");
    eq((await product(a, "Rice Pack")).stock, 12, "stock unchanged by repeated cancels");
    eq((await history(a, P1.id)).filter((h) => h.type === "sale-cancel").length, 1, "still one cancel entry");
    // a sale that takes stock to zero shows Out of stock; cancelling returns it
    const sale2 = await saleUI(a, "Rice", 12);
    await go(a, "#alerts");
    eq((await alertRows(a)).find((r) => r.name === "Rice Pack").status, "Out of stock", "sold out");
    await cancelUI(a, sale2.id);
    eq((await alertRows(a)).filter((r) => r.name === "Rice Pack").length, 0, "back in stock");
    ok(before >= 0, "sanity");
  });

  await test("T6", "Create and validate a manual stock adjustment (reason, history, reference)", async () => {
    const salesBefore = JSON.stringify(await rawAll(a, "sales"));
    // Sugar is out (0), level 3. Receive 2.5 kg through the Alerts page: that makes it Low, not Out.
    await go(a, "#alerts");
    await a.click('#alList table button[data-act="adjust"][data-id="' + P2.id + '"]');
    ok((await a.textContent("#adTitle")).includes("Loose Sugar"));
    // reason is required
    await a.fill("#aQty", "2.5");
    await a.click("#adSave");
    eq(await a.textContent("#e-aReason"), "Choose a reason.");
    eq((await product(a, "Loose Sugar")).stock, 0, "nothing saved without a reason");
    // "Other" needs a note
    await a.selectOption("#aReason", "Other");
    await a.click("#adSave");
    ok((await a.textContent("#e-aNote")).length > 0, "Other without note refused");
    // the preview shows the new status
    await a.selectOption("#aReason", "Stock received (purchase)");
    ok(/Stock after this change: 2\.5 kg \(Low stock\)/.test(await a.textContent("#adPreview")), "preview: " + await a.textContent("#adPreview"));
    await a.fill("#aNote", "Delivery 14 Oct");
    await a.click("#adSave");
    await a.waitForFunction(() => !document.getElementById("adjustDialog").open);
    await waitToast(a, /Stock updated: 0 → 2\.5 kg\. Recorded as ADJ-/);
    const prod = await product(a, "Loose Sugar");
    eq(prod.stock, 2.5);
    const h = (await history(a, P2.id)).filter((x) => x.type === "adjustment" && x.note === "Delivery 14 Oct");
    eq(h.length, 1, "one history entry");
    const e = h[0];
    eq([e.productId, e.productName, e.change, e.before, e.after, e.reason], [P2.id, "Loose Sugar", 2.5, 0, 2.5, "Stock received (purchase)"]);
    ok(/^ADJ-[0-9A-F]{8}$/.test(e.ref), "reference " + e.ref);
    ok(!Number.isNaN(Date.parse(e.createdAt)), "adjustment date recorded");
    eq((await alertRows(a)).find((r) => r.name === "Loose Sugar").status, "Low stock", "Sugar is now low, not out");
    // the same entry is visible in the movements list
    await a.click("#alMoves summary");
    await a.waitForSelector("#alMovesBody table");
    const txt = await a.textContent("#alMovesBody");
    ok(txt.includes(e.ref) && txt.includes("Delivery 14 Oct") && txt.includes("Loose Sugar") && txt.includes("Adjustment"), "movement list shows the adjustment");
    ok(txt.includes("Sale cancelled") && txt.includes("Sale"), "movement list also shows sales and cancellations");
    await a.click("#alMoves summary");
    // manual adjustments never rewrite sales
    eq(JSON.stringify(await rawAll(a, "sales")), salesBefore, "sales records are byte-for-byte unchanged");
    // history is kept per product and also opens in the product detail
    await go(a, "#products");
    await a.evaluate((id) => document.querySelector('#pList button[data-act="view"][data-id="' + id + '"]').click(), P2.id);
    await a.waitForSelector("#detailDialog[open]");
    await a.waitForSelector("#dtHistory ul.hist");
    ok((await a.textContent("#dtHistory")).includes("Delivery 14 Oct"), "history shown in product detail");
    ok((await a.textContent("#dtInfo")).includes("Low-stock alert at"), "detail shows alert level");
    await closeDialogs(a);
  });

  await test("T7", "Reject invalid quantities and unintended negative stock", async () => {
    // Rice Pack: whole-number unit. Current stock:
    const rice = await product(a, "Rice Pack");
    const n0 = (await history(a, P1.id)).length;
    const cases = [["add", ""], ["add", "0"], ["add", "-3"], ["add", "abc"], ["add", "1e3"], ["add", "2.5"], ["add", "1,5"], ["add", "12345678"], ["remove", String(rice.stock + 1)]];
    for (const [dir, qty] of cases) {
      await openAdjust(a, P1.id, { dir, qty, reason: "Count correction" });
      await a.click("#adSave");
      ok((await a.textContent("#e-aQty")).length > 0, "no quantity error for " + dir + " '" + qty + "'");
      ok(await a.evaluate(() => document.getElementById("adjustDialog").open), "dialog must stay open for '" + qty + "'");
      await a.click("#adCancel");
    }
    await openAdjust(a, P1.id, { dir: "remove", qty: String(rice.stock + 1), reason: "Count correction" });
    await a.click("#adSave");
    ok(/below zero/.test(await a.textContent("#e-aQty")), "negative-stock message");
    await a.click("#adCancel");
    eq((await product(a, "Rice Pack")).stock, rice.stock, "stock unchanged after all invalid attempts");
    eq((await history(a, P1.id)).length, n0, "no history written by invalid attempts");
    // the data layer refuses them too (not just the screen)
    const sugar = await product(a, "Loose Sugar");
    const bad = await a.evaluate(async (a) => {
      const out = {};
      const tryIt = async (k, fn) => { try { await fn(); out[k] = "ACCEPTED"; } catch (e) { out[k] = e.message; } };
      await tryIt("nan", () => DukaanProducts.adjust(a.rice, NaN, "r"));
      await tryIt("zero", () => DukaanProducts.adjust(a.rice, 0, "r"));
      await tryIt("inf", () => DukaanProducts.adjust(a.rice, Infinity, "r"));
      await tryIt("string", () => DukaanProducts.adjust(a.rice, "5", "r"));
      await tryIt("decimalOnWhole", () => DukaanProducts.adjust(a.rice, 1.5, "r"));
      await tryIt("fourDecimals", () => DukaanProducts.adjust(a.sugar, 1.0005, "r"));
      await tryIt("negative", () => DukaanProducts.adjust(a.rice, -(a.riceStock + 1), "r"));
      await tryIt("noReason", () => DukaanProducts.adjust(a.rice, 1, "  "));
      await tryIt("missing", () => DukaanProducts.adjust("no-such-id", 1, "r"));
      return out;
    }, { rice: P1.id, sugar: P2.id, riceStock: rice.stock });
    Object.keys(bad).forEach((k) => ok(bad[k] !== "ACCEPTED", "data layer accepted: " + k));
    ok(/below zero/.test(bad.negative), "negative message: " + bad.negative);
    ok(/not found/i.test(bad.missing), "missing product message: " + bad.missing);
    ok(/reason/i.test(bad.noReason), "reason message: " + bad.noReason);
    eq((await product(a, "Rice Pack")).stock, rice.stock, "stock still unchanged");
    eq((await history(a, P1.id)).length, n0, "history still unchanged");
    // zero is allowed as a result (removing everything) and archived products are refused
    const toZero = await a.evaluate((x) => DukaanProducts.adjust(x.id, -x.s, "Damaged"), { id: P1.id, s: rice.stock });
    eq(toZero.after, 0, "removing exactly all stock is allowed");
    await adjustUI(a, P1.id, { dir: "add", qty: "12", reason: "Stock received (purchase)" });
    // missing product while the dialog is open: error shown, no success, nothing saved
    const P3 = await addProduct(a, { name: "Temp Item", unit: "piece", cost: 5, price: 9, opening: 4, low: 1 });
    await openAdjust(a, P3.id, { dir: "add", qty: "2", reason: "Count correction" });
    await rawWrite(a, "products", "delete", P3.id);
    await a.evaluate(() => { document.getElementById("toast").textContent = ""; document.getElementById("toast").hidden = true; });
    await a.click("#adSave");
    await a.waitForSelector("#adError:not([hidden])");
    ok(/not found/i.test(await a.textContent("#adError")), "banner: " + await a.textContent("#adError"));
    ok(await a.evaluate(() => document.getElementById("adjustDialog").open), "dialog stays open");
    ok(!/Stock updated/.test(await toastText(a)), "no success toast");
    eq((await history(a, P3.id)).filter((h) => h.type === "adjustment").length, 0, "no history for the missing product");
    await a.click("#adCancel");
    await settle(a);
    // a database error in the middle of the save rolls everything back and shows no success
    const stock0 = (await product(a, "Rice Pack")).stock;
    await a.evaluate(() => {
      const orig = IDBObjectStore.prototype.add;
      window.__restoreAdd = () => { IDBObjectStore.prototype.add = orig; };
      IDBObjectStore.prototype.add = function () { if (this.name === "stockHistory") throw new DOMException("forced failure", "QuotaExceededError"); return orig.apply(this, arguments); };
    });
    await openAdjust(a, P1.id, { dir: "add", qty: "3", reason: "Count correction" });
    await a.evaluate(() => { document.getElementById("toast").hidden = true; document.getElementById("toast").textContent = ""; });
    await a.click("#adSave");
    await a.waitForSelector("#adError:not([hidden])");
    ok((await a.textContent("#adError")).length > 0, "error text shown");
    ok(!/Stock updated/.test(await toastText(a)), "no success toast on failure");
    await a.evaluate(() => window.__restoreAdd());
    eq((await product(a, "Rice Pack")).stock, stock0, "stock rolled back (product + history are one transaction)");
    // the same dialog can simply be retried once storage works again, and saves once
    await a.click("#adSave");
    await a.waitForFunction(() => !document.getElementById("adjustDialog").open);
    await settle(a);
    eq((await product(a, "Rice Pack")).stock, stock0 + 3, "retry after the error saved exactly once");
  });

  await test("T8", "Prevent duplicate adjustments from repeated submissions", async () => {
    const s0 = (await product(a, "Rice Pack")).stock;
    const h0 = (await history(a, P1.id)).length;
    // (a) three submits in the same instant
    await openAdjust(a, P1.id, { dir: "add", qty: "3", reason: "Count correction", note: "triple submit" });
    await a.evaluate(() => { const f = document.getElementById("adjustForm"); f.requestSubmit(); f.requestSubmit(); f.requestSubmit(); });
    await a.waitForFunction(() => !document.getElementById("adjustDialog").open);
    await settle(a);
    eq((await product(a, "Rice Pack")).stock, s0 + 3, "stock changed once");
    eq((await history(a, P1.id)).filter((h) => h.note === "triple submit").length, 1, "one history entry");
    // (b) a double click on the Save button
    await openAdjust(a, P1.id, { dir: "add", qty: "2", reason: "Count correction", note: "double click" });
    await a.dblclick("#adSave");
    await a.waitForFunction(() => !document.getElementById("adjustDialog").open);
    await settle(a);
    eq((await product(a, "Rice Pack")).stock, s0 + 5);
    eq((await history(a, P1.id)).filter((h) => h.note === "double click").length, 1);
    // (c) two requests with the same operation id at the same time: one applies, one is reported as a duplicate
    const op = await uid(a);
    const r = await a.evaluate((x) => Promise.all([DukaanProducts.adjust(x.id, 2, "Count correction", "same op", x.op), DukaanProducts.adjust(x.id, 2, "Count correction", "same op", x.op)]), { id: P1.id, op });
    eq(r.map((x) => x.duplicate).sort(), [false, true], "one real, one duplicate");
    eq((await product(a, "Rice Pack")).stock, s0 + 7, "stock changed once for the same operation id");
    eq((await history(a, P1.id)).filter((h) => h.note === "same op").length, 1);
    eq((await rawAll(a, "stockHistory")).filter((h) => h.id === op).length, 1, "history id is the operation id");
    // (d) sending it again later is still a no-op
    const again = await a.evaluate((x) => DukaanProducts.adjust(x.id, 2, "Count correction", "same op", x.op), { id: P1.id, op });
    eq(again.duplicate, true);
    eq((await product(a, "Rice Pack")).stock, s0 + 7, "still unchanged");
    // (e) two different operations are both real (a shop can legitimately adjust twice)
    const o1 = await uid(a), o2 = await uid(a);
    await a.evaluate((x) => Promise.all([DukaanProducts.adjust(x.id, 1, "Count correction", "two ops", x.o1), DukaanProducts.adjust(x.id, 1, "Count correction", "two ops", x.o2)]), { id: P1.id, o1, o2 });
    eq((await product(a, "Rice Pack")).stock, s0 + 9, "two different operations both applied");
    eq((await history(a, P1.id)).length, h0 + 1 + 1 + 1 + 2, "history count matches the real changes only");
  });

  await test("T9", "Stock, thresholds and movement history survive a reload", async () => {
    const snap = async () => ({
      products: (await rawAll(a, "products")).map((p) => [p.name, p.stock, p.lowStockThreshold, p.status]).sort(),
      hist: (await rawAll(a, "stockHistory")).map((h) => h.id).sort(),
      alerts: await a.evaluate(() => DukaanAlerts.rows().map((r) => [r.name, r.stock, r.level, r.status]).sort())
    });
    // leave Rice low so there is an alert to come back
    const st = (await product(a, "Rice Pack")).stock;
    await adjustUI(a, P1.id, { dir: "remove", qty: String(st - 10), reason: "Damaged" });
    const before = await snap();
    ok(before.alerts.length >= 1, "there is an alert before reload");
    const histCount = (await history(a, P1.id)).length;
    await a.reload();
    await ready(a);
    const after = await snap();
    eq(after, before, "products, history ids and alerts identical after reload");
    await go(a, "#alerts");
    eq((await alertRows(a)).length, before.alerts.length, "alerts page shows them after reload");
    await go(a, "#products");
    await a.evaluate((id) => document.querySelector('#pList button[data-act="view"][data-id="' + id + '"]').click(), P1.id);
    await a.waitForSelector("#dtHistory ul.hist");
    eq(await a.$$eval("#dtHistory li", (l) => l.length), histCount, "product history list has every entry after reload");
    await closeDialogs(a);
    // a second tab in the same profile sees the same data
    const page2 = await A.context.newPage();
    await page2.goto(base + "/index.html");
    await ready(page2);
    eq((await product(page2, "Rice Pack")).stock, 10);
    await page2.close();
  });

  await test("X3", "Products with no saved level use the default (5), and the screens say so", async () => {
    const mk = (name, stock, extra) => Object.assign({ id: "legacy-" + name, name, sku: "", barcode: "", category: "General", unit: "piece", cost: 1, price: 2, stock, status: "active", description: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, extra || {});
    await rawWrite(a, "products", "put", mk("Legacy Five", 5));          // no lowStockThreshold at all
    await rawWrite(a, "products", "put", mk("Legacy Six", 6));
    await rawWrite(a, "products", "put", mk("Legacy Null", 2, { lowStockThreshold: null }));
    await rawWrite(a, "products", "put", mk("Legacy Zero", 0, { lowStockThreshold: 0 }));  // level 0: only out-of-stock
    await rawWrite(a, "products", "put", mk("Legacy ZeroLevel", 1, { lowStockThreshold: 0 }));
    await settle(a);
    await go(a, "#alerts");
    const rows = await alertRows(a);
    const by = (n) => rows.find((r) => r.name === n);
    eq(by("Legacy Five").status, "Low stock", "5 <= default 5");
    eq(by("Legacy Five").level, "5 piece (default)", "default level is labelled");
    eq(by("Legacy Null").level, "5 piece (default)");
    eq(by("Legacy Six"), undefined, "6 > default 5: no alert");
    eq(by("Legacy Zero").status, "Out of stock", "level 0 still alerts at zero");
    eq(by("Legacy ZeroLevel"), undefined, "level 0 means no low-stock warning");
    ok((await a.textContent("#alInfo")).includes("default of 5"), "the page explains the default");
    // the edit form shows the default and says it is not saved yet
    await a.evaluate(() => DukaanProducts.openEdit("legacy-Legacy Five"));
    eq(await a.inputValue("#fLow"), "5");
    ok(/no level saved, so 5 is shown/.test(await a.textContent("#lowHint")), "form explains: " + await a.textContent("#lowHint"));
    await a.click("#pdSave");
    await a.waitForFunction(() => !document.getElementById("productDialog").open);
    eq((await product(a, "Legacy Five")).lowStockThreshold, 5, "saving stores the level");
    await settle(a);
    eq((await alertRows(a)).find((r) => r.name === "Legacy Five").level, "5 piece", "no longer marked default once saved");
    // CSV and detail use the effective level
    const csv = await a.evaluate(() => DukaanProducts.toCsv());
    ok(csv.includes('"Legacy Null"') && /"Legacy Null".*"5"/.test(csv.split("\r\n").find((l) => l.includes("Legacy Null"))), "CSV exports the effective level");
    for (const n of ["Legacy Five", "Legacy Six", "Legacy Null", "Legacy Zero", "Legacy ZeroLevel"]) await rawWrite(a, "products", "delete", "legacy-" + n);
    await settle(a);
  });

  await test("T14", "Alerts and adjustments keep working offline after the app has loaded", async () => {
    await A.context.setOffline(true);
    try {
      ok(await a.evaluate(() => navigator.onLine === false), "browser reports offline");
      await a.evaluate(() => window.dispatchEvent(new Event("offline")));
      eq((await a.textContent("#netStatus .status-text")).trim(), "Offline");
      const s = (await product(a, "Rice Pack")).stock;
      await adjustUI(a, P1.id, { dir: "add", qty: "5", reason: "Stock received (purchase)" });
      eq((await product(a, "Rice Pack")).stock, s + 5, "adjustment saved while offline");
      await go(a, "#alerts");
      eq((await alertRows(a)).filter((r) => r.name === "Rice Pack").length, 0, "alert list updated offline");
    } finally {
      await A.context.setOffline(false);
    }
  });

  /* Loading and storage-failure states of the alerts screen */
  await test("X4", "Loading state and storage-failure state of the Alerts page", async () => {
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    await pg.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => setTimeout(() => { window.__early = document.getElementById("alCount").textContent; }, 0));
    });
    await pg.goto(base + "/index.html");
    const early = await pg.evaluate(() => window.__early);
    await pg.close();
    ok(early === "Loading stock levels…", "loading text was: " + JSON.stringify(early));
    const p2 = await ctx.newPage();
    await p2.addInitScript(() => { Object.defineProperty(window, "indexedDB", { get: () => undefined }); });
    await p2.goto(base + "/index.html#alerts");
    await p2.waitForSelector("#alError:not([hidden])", { timeout: 8000 });
    ok(/could not be read/.test(await p2.textContent("#alError")), "error banner text");
    const cards = await p2.$$eval("#alCards .card-value", (c) => c.map((x) => x.textContent));
    eq(cards, ["–", "–"], "counts show a dash, not a fake 0");
    const dcards = await p2.$$eval("#cardsStock .card-value", (c) => c.map((x) => x.textContent));
    ok(dcards.slice(0, 3).every((v) => v === "–"), "dashboard shows dashes: " + dcards);
    await ctx.close();
  });
  await test("X5", "Empty state when there are no products at all", async () => {
    const E = await openApp(browser);
    await go(E.page, "#alerts");
    ok((await E.page.textContent("#alList")).includes("No products yet"), "empty state");
    eq(await E.page.$$eval("#alCards .card-value", (c) => c.map((x) => x.textContent)), ["0", "0"]);
    await E.page.click("#alList button");
    await E.page.waitForSelector("#view-products:not([hidden])");
    await E.context.close();
  });

  /* =====================================================================
   * GROUP M: mobile layout
   * ===================================================================== */
  await test("X6", "Mobile layout: alerts as cards, no sideways scrolling, usable buttons", async () => {
    const M = await openApp(browser, { viewport: { width: 375, height: 760 } });
    const m = M.page;
    await addProduct(m, { name: "Mobile Soap With A Rather Long Product Name Here", unit: "piece", cost: 10, price: 20, opening: 2, low: 5 });
    await addProduct(m, { name: "Mobile Tea", unit: "packet", cost: 10, price: 20, opening: 0, low: 5 });
    await m.click("#bottomNav button >> nth=-1"); // More
    await m.click('#navList button[data-page="alerts"]');
    await m.waitForSelector("#view-alerts:not([hidden])");
    eq(await m.$$eval("#alList .p-card", (c) => c.length), 2, "two cards");
    ok(await m.evaluate(() => getComputedStyle(document.querySelector("#alList .table-wrap")).display === "none"), "table hidden on phone");
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(overflow <= 1, "horizontal overflow of " + overflow + "px");
    const small = await m.$$eval("#alList .p-card button", (b) => b.filter((x) => x.getBoundingClientRect().height < 40).length);
    eq(small, 0, "buttons are at least 40px tall");
    ok((await m.textContent("#alCards")).includes("Low stock") && (await m.textContent("#alCards")).includes("Out of stock"));
    await m.click('#alList .p-card button[data-act="adjust"] >> nth=0');
    ok(await m.evaluate(() => document.getElementById("adjustDialog").open), "adjust dialog opens on phone");
    const dlg = await m.evaluate(() => document.getElementById("adjustDialog").getBoundingClientRect().width);
    ok(dlg <= 375, "dialog fits the screen (" + dlg + ")");
    await m.click("#adCancel");
    // dashboard cards and the product form hint fit as well
    await go(m, "#dashboard");
    eq(await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1), true, "dashboard has no sideways scroll");
    await m.click("#bottomNav button >> nth=-1");
    await M.context.close();
  });

  await browser.close();
  /* the groups below need their own browsers so that they cannot disturb group A */
  const browser2 = await chromium.launch({ args: ["--no-sandbox"] });

  /* =====================================================================
   * GROUP R: Phases 1-7 regression in an isolated profile
   * ===================================================================== */
  const R = await openApp(browser2);
  const r = R.page;
  const R_ = {};
  let backupText = "";

  await test("T10a", "Settings: shop name saves, shows in the header and survives a reload", async () => {
    await go(r, "#settings");
    await r.fill("#stName", "Test Kirana Store");
    await r.fill("#stPrefix", "TK");
    await r.click("#stSave");
    await r.waitForFunction(() => DukaanSettings.get().name === "Test Kirana Store");
    eq((await r.textContent("#shopName")).trim(), "Test Kirana Store");
    await r.reload(); await ready(r);
    eq(await r.evaluate(() => DukaanSettings.get().name), "Test Kirana Store");
    eq(await r.evaluate(() => DukaanSettings.get().prefix), "TK");
  });

  await test("T10b", "Products, billing (cash sale) and stock deduction", async () => {
    R_.atta = await addProduct(r, { name: "Atta 5kg", unit: "packet", cost: 70, price: 100, opening: 50, low: 5 });
    eq((await product(r, "Atta 5kg")).stock, 50);
    R_.cash = await saleUI(r, "Atta", 3);
    eq((await product(r, "Atta 5kg")).stock, 47, "stock after cash sale");
    eq([R_.cash.total, R_.cash.invoiceNo, R_.cash.status, R_.cash.outstanding], [300, "TK-000001", "completed", 0]);
    eq((await rawAll(r, "stockHistory")).filter((h) => h.type === "sale").length, 1);
  });

  await test("T10c", "Customer creation (UI), credit sale, balance from the ledger", async () => {
    await go(r, "#customers");
    await r.evaluate(() => DukaanCustomers.openForm());
    await r.fill("#fcName", "Ramesh Kumar");
    await r.fill("#fcPhone", "9876543210");
    await r.click("#fcSave");
    await r.waitForFunction(() => DukaanLedger.customers().length === 1);
    R_.cust = await r.evaluate(() => DukaanLedger.customers()[0]);
    eq((await rawAll(r, "customers")).length, 1, "customer in IndexedDB");
    const sale = await r.evaluate(async (c) => {
      const s = await DukaanSales.complete({ id: DukaanDB.uid(), items: [{ productId: c.pid, qty: 5, unitPrice: 100 }], payments: [{ method: "cash", amount: 100 }], customerId: c.id, prefix: "TK" });
      document.dispatchEvent(new CustomEvent("stock-changed"));
      await DukaanSales.refresh();
      return s;
    }, { pid: R_.atta.id, id: R_.cust.id });
    R_.credit = sale;
    eq([sale.total, sale.amountPaid, sale.outstanding, sale.invoiceNo], [500, 100, 400, "TK-000002"]);
    eq((await product(r, "Atta 5kg")).stock, 42);
    const bal = (await rawAll(r, "ledger")).filter((l) => l.customerId === R_.cust.id).reduce((a, l) => a + Math.round(l.amount * 100), 0);
    eq(bal, 40000, "customer balance from raw ledger = 400.00");
    eq(Math.round((await r.evaluate((id) => DukaanLedger.balance(id), R_.cust.id)) * 100), 40000, "ledger API agrees");
    // credit without a customer is refused and changes nothing
    const refused = await r.evaluate((pid) => DukaanSales.complete({ id: DukaanDB.uid(), items: [{ productId: pid, qty: 1, unitPrice: 100 }], payments: [], customerId: "", prefix: "TK" }).then(() => "ACCEPTED", (e) => e.code), R_.atta.id);
    eq(refused, "CUSTOMER_REQUIRED");
    eq((await product(r, "Atta 5kg")).stock, 42, "failed sale leaves stock alone");
  });

  await test("T10d", "Repayment reduces the balance, is not revenue, and cannot be duplicated or overpaid", async () => {
    const id = await uid(r);
    const rep = await r.evaluate((x) => DukaanLedger.recordRepayment({ id: x.id, customerId: x.c, method: "cash", amount: 150 }), { id, c: R_.cust.id });
    eq(rep.balanceAfter, 250);
    const dup = await r.evaluate((x) => DukaanLedger.recordRepayment({ id: x.id, customerId: x.c, method: "cash", amount: 150 }).then(() => "ACCEPTED", (e) => e.code), { id, c: R_.cust.id });
    eq(dup, "DUPLICATE");
    const over = await r.evaluate((x) => DukaanLedger.recordRepayment({ id: DukaanDB.uid(), customerId: x.c, method: "cash", amount: 300 }).then(() => "ACCEPTED", (e) => e.code), { c: R_.cust.id });
    eq(over, "OVERPAYMENT");
    await r.evaluate(() => DukaanSales.refresh());
    eq(Math.round((await r.evaluate((i) => DukaanLedger.balance(i), R_.cust.id)) * 100), 25000, "balance after repayment = 250.00");
    eq((await rawAll(r, "repayments")).length, 1, "one repayment stored");
    const rv = await r.evaluate(() => { const S = DukaanSales, L = DukaanLedger; return S.dashboard().today.sales; });
    eq(rv, 800, "repayment is not counted as sales revenue (300 + 500)");
  });

  await test("T10e", "Cancellation restores stock exactly once; cancelled sale leaves revenue", async () => {
    await cancelUI(r, R_.cash.id);
    eq((await product(r, "Atta 5kg")).stock, 45, "47 -> 50 would be wrong: stock was 42, +3 once = 45");
    const again = await r.evaluate((id) => DukaanSales.cancel(id, "second try").then(() => "ACCEPTED", (e) => e.code), R_.cash.id);
    eq(again, "ALREADY_CANCELLED");
    eq((await product(r, "Atta 5kg")).stock, 45, "second cancel changed nothing");
    eq(await r.evaluate(() => DukaanSales.dashboard().today.sales), 500, "cancelled bill excluded from sales");
  });

  await test("T10f", "Expenses and reports: totals are separate and correct", async () => {
    const today = await r.evaluate(() => DukaanUtil.todayKey());
    await r.evaluate((d) => DukaanExpenses.create({ id: DukaanDB.uid(), date: d, description: "Shop rent", category: "Rent", amountP: 12000, method: "cash", notes: "" }), today);
    await r.evaluate(() => DukaanExpenses.refresh());
    const rep = await r.evaluate(() => {
      const L = DukaanLedger;
      return DukaanReports.compute(DukaanSales.cached(), L.repayments(), DukaanExpenses.list(), DukaanReports.rangeFor("today"), Math.round(L.totalOutstanding() * 100), 0);
    });
    eq([rep.bills, rep.salesP, rep.atSaleP, rep.repaidP, rep.receivedP], [1, 50000, 10000, 15000, 25000], "sales / received split");
    eq([rep.expensesP, rep.creditP], [12000, 25000], "expenses and outstanding credit");
    eq([rep.grossReliable, rep.grossP, rep.netP], [true, 15000, 3000], "gross = 500 - 5x70 = 150; net = 150 - 120 = 30");
    // an expense outside the range is not counted; a voided one is not counted
    const old = await r.evaluate(() => DukaanReports.compute(DukaanSales.cached(), DukaanLedger.repayments(), DukaanExpenses.list(), { from: "2000-01-01", to: "2000-01-31" }, 0, 0));
    eq([old.bills, old.expensesP], [0, 0], "date filter excludes today's records");
    // the Reports screen itself renders these figures
    await go(r, "#reports");
    const txt = await r.textContent("#view-reports");
    ok(txt.includes("500") && txt.includes("120"), "reports screen shows sales and expenses");
    await go(r, "#dashboard");
    ok((await r.textContent("#cardsMoney")).includes("500"), "dashboard shows the day's sales");
  });

  await test("T10g", "Stock history and alerts stay right alongside billing (Atta drops to Low)", async () => {
    await adjustUI(r, R_.atta.id, { dir: "remove", qty: "40", reason: "Damaged", note: "Rain damage" });
    eq((await product(r, "Atta 5kg")).stock, 5);
    await go(r, "#alerts");
    eq((await alertRows(r)).map((x) => [x.name, x.status, x.stock]), [["Atta 5kg", "Low stock", "5 packet"]]);
    // billing still checks current stock: 6 cannot be sold, 5 can
    await go(r, "#sale");
    const refused = await r.evaluate((pid) => DukaanSales.complete({ id: DukaanDB.uid(), items: [{ productId: pid, qty: 6, unitPrice: 100 }], payments: [{ method: "cash", amount: 600 }], prefix: "TK" }).then(() => "ACCEPTED", (e) => e.code), R_.atta.id);
    eq(refused, "INSUFFICIENT_STOCK");
    eq((await product(r, "Atta 5kg")).stock, 5);
  });

  await test("T10h", "Backup export includes everything, including stock movement history", async () => {
    backupText = await r.evaluate(async () => JSON.stringify(await DukaanBackup.buildBackup()));
    const b = JSON.parse(backupText);
    eq(b.shopName, "Test Kirana Store");
    eq([b.counts.products, b.counts.customers, b.counts.sales, b.counts.repayments, b.counts.expenses], [1, 1, 2, 1, 1]);
    eq(b.counts.stockHistory, 5, "opening + 2 sales + 1 cancel + 1 adjustment are all in the backup");
    ok(b.stores.stockHistory.some((h) => h.type === "adjustment" && /^ADJ-/.test(h.ref)), "adjustment reference is in the backup");
    eq(await r.evaluate((t) => DukaanBackup.validate(t).ok, backupText), true, "validator accepts it");
  });

  /* restore in a different, empty profile through the real screen */
  await test("T10i", "Restore the backup into an empty isolated profile; everything is preserved", async () => {
    const C = await openApp(browser2);
    const c = C.page;
    await go(c, "#settings");
    // an invalid file is rejected and nothing changes
    await c.setInputFiles("#bkFile", { name: "bad.json", mimeType: "application/json", buffer: Buffer.from("{not json") });
    await c.waitForFunction(() => { const m = document.getElementById("bkMsg"); return m && !m.hidden && m.textContent.length > 0; });
    ok(/not a readable backup|not a Dukaan/.test(await c.textContent("#bkMsg")), "bad file message: " + await c.textContent("#bkMsg"));
    eq((await rawAll(c, "products")).length, 0, "nothing was restored");
    // now the real file
    await c.setInputFiles("#bkFile", { name: "good.json", mimeType: "application/json", buffer: Buffer.from(backupText) });
    await c.waitForSelector("#bkConfirmBox:not([hidden])");
    eq(await c.isDisabled("#bkRestore"), true, "restore is locked until the user confirms");
    await c.check("#bkAck");
    await c.click("#bkRestore");
    await c.click("#askOk"); // the second, in-app confirmation
    await c.waitForFunction(() => DukaanProducts.list().length === 1, null, { timeout: 10000 });
    await c.waitForTimeout(300);
    const get = async (s) => (await rawAll(c, s));
    eq((await get("products")).map((p) => [p.name, p.stock, p.lowStockThreshold]), [["Atta 5kg", 5, 5]]);
    eq([(await get("customers")).length, (await get("sales")).length, (await get("repayments")).length, (await get("expenses")).length], [1, 2, 1, 1]);
    eq((await get("stockHistory")).length, JSON.parse(backupText).counts.stockHistory, "all stock movements restored");
    eq(await c.evaluate(() => DukaanSettings.get().name), "Test Kirana Store", "settings restored");
    eq(Math.round((await c.evaluate((id) => DukaanLedger.balance(id), R_.cust.id)) * 100), 25000, "customer balance restored");
    // alerts and dashboard recalculated from the restored data, without reloading
    await go(c, "#alerts");
    eq((await alertRows(c)).map((x) => [x.name, x.status]), [["Atta 5kg", "Low stock"]], "alert list rebuilt after restore");
    eq((await dash(c))["Low stock"], "1");
    // stock history from the old profile can still be listed in the movements panel
    await c.click("#alMoves summary");
    await c.waitForSelector("#alMovesBody table");
    ok((await c.textContent("#alMovesBody")).includes("Rain damage"), "movement list after restore");
    // and it all survives a reload
    await c.reload(); await ready(c);
    eq((await product(c, "Atta 5kg")).stock, 5);
    eq(await c.evaluate(() => DukaanAlerts.rows().length), 1);
    // restoring does not let a later adjustment duplicate: adjust once after restore
    await adjustUI(c, (await product(c, "Atta 5kg")).id, { dir: "add", qty: "10", reason: "Stock received (purchase)" });
    eq((await product(c, "Atta 5kg")).stock, 15);
    eq(await c.evaluate(() => DukaanAlerts.rows().length), 0, "alert cleared after adding stock");
    await C.context.close();
  });

  /* =====================================================================
   * GROUP U: upgrade from the Phase 7 files, same browser profile
   * ===================================================================== */
  if (!PHASE7 || !fs.existsSync(path.join(PHASE7, "index.html"))) {
    blocked("T11", "Upgrade from Phase 7 keeps existing records", "PHASE7_DIR was not set to an unzipped Phase 7 folder");
  } else {
    await test("T11", "Upgrade from Phase 7 keeps every existing record and computes alerts from it", async () => {
      srv.root = PHASE7;
      const U = await openApp(browser2);
      const u = U.page;
      ok(!(await u.evaluate(() => !!window.DukaanAlerts)), "this really is the Phase 7 app");
      // seed with Phase 7's own screens and rules
      await u.evaluate(async () => {
        const mk = (name, stock, low) => ({ id: DukaanDB.uid(), name, sku: "", barcode: "", category: "General", unit: "piece", cost: 5, price: 10, stock, lowStockThreshold: low, status: "active", description: "", createdAt: DukaanDB.now(), updatedAt: DukaanDB.now() });
        for (const p of [mk("Pen", 3, 5), mk("Notebook", 0, 5), mk("Bag", 20, 5), mk("Ruler", 5, 5)]) await DukaanDB.run(["products", "stockHistory"], "readwrite", (tx) => { tx.objectStore("products").add(p); });
        await DukaanProducts.refresh();
      });
      const bag = await product(u, "Bag");
      await u.evaluate(async (pid) => {
        await DukaanSales.complete({ id: DukaanDB.uid(), items: [{ productId: pid, qty: 2, unitPrice: 10 }], payments: [{ method: "upi", amount: 20 }], prefix: "INV" });
        await DukaanLedger.createCustomer({ id: DukaanDB.uid(), name: "Old Customer", phone: "", openingP: 5000 });
      }, bag.id);
      const stores = ["products", "stockHistory", "sales", "counters", "settings", "customers", "ledger", "repayments", "expenses"];
      const snap = {};
      for (const s of stores) snap[s] = JSON.stringify(await rawAll(u, s));
      const v0 = await rawDbVersion(u);
      // swap in the Phase 8 files, same origin, same profile
      srv.root = ROOT;
      await u.reload();
      await ready(u);
      ok(await u.evaluate(() => !!window.DukaanAlerts), "Phase 8 is now running");
      for (const s of stores) eq(JSON.stringify(await rawAll(u, s)), snap[s], "store " + s + " untouched by the upgrade");
      eq(await rawDbVersion(u), v0, "database version unchanged (no migration needed)");
      eq(await dash(u).then((d) => [d["Low stock"], d["Out of stock"]]), ["2", "1"], "Pen+Ruler low, Notebook out");
      await go(u, "#alerts");
      eq((await alertRows(u)).map((x) => [x.name, x.status]), [["Notebook", "Out of stock"], ["Pen", "Low stock"], ["Ruler", "Low stock"]]);
      // old data still works for new features: adjust an old product and sell it
      await adjustUI(u, (await product(u, "Pen")).id, { dir: "add", qty: "10", reason: "Stock received (purchase)" });
      eq((await product(u, "Pen")).stock, 13);
      const sale = await saleUI(u, "Bag", 1);
      eq([sale.total, (await product(u, "Bag")).stock], [10, 17], "old product sells and stock decreases");
      eq(Math.round((await u.evaluate(() => DukaanLedger.customers().map((c) => DukaanLedger.balance(c.id))))[0] * 100), 5000, "opening balance intact");
      await U.context.close();
    });
  }

  /* =====================================================================
   * Console / network cleanliness over the whole run
   * ===================================================================== */
  await browser2.close();
  const flat = [];
  allErrors.forEach((x) => x.page.errs.forEach((e) => flat.push(e)));
  await test("T15", "No JavaScript errors, console errors or failed requests during the whole run", async () => {
    ok(flat.length === 0, flat.length + " problem(s): " + flat.slice(0, 5).join(" | "));
  });

  /* ---------- summary ---------- */
  const count = (s) => results.filter((x) => x.status === s).length;
  console.log("\n==== SUMMARY: " + count("PASS") + " PASS, " + count("FAIL") + " FAIL, " + count("BLOCKED") + " BLOCKED ====");
  fs.writeFileSync(path.join(__dirname, "phase8-results.json"), JSON.stringify(results, null, 2));
  server.close();
  process.exit(count("FAIL") ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });