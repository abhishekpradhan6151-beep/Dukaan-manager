/*
 * backup.js - Phase 6: export and restore all shop data as one JSON file.
 *
 * EXPORT reads every store in ONE read-only transaction, so the file is a consistent snapshot and
 * the database is not changed.
 * RESTORE validates the whole file first (format, version, types, unique ids, links between
 * records). Only then, after typed confirmation, it replaces everything in ONE read-write transaction
 * over all stores. IndexedDB transactions are all-or-nothing: if anything fails the transaction is
 * aborted and the previous data stays exactly as it was. There is no merge: restore is full replacement.
 */
(function () {
  "use strict";

  const DB = window.DukaanDB;
  const U = window.DukaanUtil;
  const $ = U.$;
  const el = U.el;

  const FORMAT = "dukaan-manager-backup";
  const FORMAT_VERSION = 1;
  const DB_VERSION = 4; // the database version this app writes
  const MAX_BYTES = 150 * 1024 * 1024;
  const STORES = ["products", "stockHistory", "sales", "counters", "settings", "customers", "ledger", "repayments", "expenses"];
  const LABELS = { products: "Products", stockHistory: "Stock history entries", sales: "Sales (with items and payments)", counters: "Number counters", settings: "Settings",
    customers: "Customers", ledger: "Udhaar ledger entries", repayments: "Repayments", expenses: "Expenses" };
  const KEY = { counters: "name", settings: "key" }; // every other store uses "id"

  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const isStr = (x) => typeof x === "string";

  /* ---------- export ---------- */

  function safeName(s) {
    const n = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
    return n || "shop";
  }

  async function snapshot() {
    return DB.run(STORES, "readonly", async (tx) => {
      const out = {};
      for (const s of STORES) out[s] = await DB.req(tx.objectStore(s).getAll());
      return out;
    });
  }

  async function buildBackup() {
    const stores = await snapshot();
    const shop = (stores.settings.find((r) => r.key === "shop") || {}).value || {};
    const counts = {}; STORES.forEach((s) => { counts[s] = stores[s].length; });
    return { format: FORMAT, formatVersion: FORMAT_VERSION, dbVersion: DB_VERSION, createdAt: new Date().toISOString(),
      shopName: isStr(shop.name) ? shop.name : "", counts: counts, stores: stores };
  }

  /* ---------- validation ---------- */

  // Returns { ok:true, backup } or { ok:false, error } with a plain-language message.
  function validate(text) {
    let b;
    try { b = JSON.parse(text); } catch (_) { return bad("This file is not a readable backup. It may be damaged, cut short, or not a Dukaan Manager backup."); }
    if (!isObj(b) || b.format !== FORMAT) return bad("This is not a Dukaan Manager backup file.");
    if (!Number.isInteger(b.formatVersion) || b.formatVersion < 1) return bad("The backup has no valid format version.");
    if (b.formatVersion > FORMAT_VERSION) return bad("This backup was made by a newer version of the app (format " + b.formatVersion + "). Update the app, then try again.");
    if (!Number.isInteger(b.dbVersion) || b.dbVersion > DB_VERSION) return bad("This backup comes from a newer database version, which this app cannot read safely.");
    if (!isObj(b.stores)) return bad("The backup has no data section.");
    const extra = Object.keys(b.stores).filter((k) => !STORES.includes(k));
    if (extra.length) return bad("The backup contains data this app does not know (" + extra.join(", ") + "), so it cannot be restored safely.");
    for (const s of STORES) if (!Array.isArray(b.stores[s])) return bad("The backup is missing the section “" + LABELS[s] + "”.");

    const ids = {};
    for (const s of STORES) {
      const key = KEY[s] || "id";
      ids[s] = new Set();
      for (let i = 0; i < b.stores[s].length; i++) {
        const r = b.stores[s][i];
        const where = LABELS[s] + " #" + (i + 1);
        if (!isObj(r)) return bad(where + " is not a valid record.");
        if (!isStr(r[key]) || !r[key]) return bad(where + " has no “" + key + "”.");
        if (ids[s].has(r[key])) return bad("Duplicate ID in " + LABELS[s] + ": “" + r[key] + "”. The backup is inconsistent and was not restored.");
        ids[s].add(r[key]);
        const e = checkRecord(s, r);
        if (e) return bad(where + ": " + e);
      }
    }
    // unique invoice numbers and repayment references (the database enforces these too)
    for (const [s, f] of [["sales", "invoiceNo"], ["repayments", "refNo"]]) {
      const seen = new Set();
      for (const r of b.stores[s]) { if (seen.has(r[f])) return bad("Two records in " + LABELS[s] + " share the number “" + r[f] + "”."); seen.add(r[f]); }
    }
    // links between records
    const link = (s, f, target, optional) => {
      for (const r of b.stores[s]) {
        const v = r[f];
        if ((v === null || v === undefined || v === "") && optional) continue;
        if (!ids[target].has(v)) return LABELS[s] + " point to a missing record (" + f + " “" + v + "”).";
      }
      return "";
    };
    const linkErr = link("ledger", "customerId", "customers") || link("ledger", "saleId", "sales", true) || link("ledger", "repaymentId", "repayments", true)
      || link("repayments", "customerId", "customers") || link("sales", "customerId", "customers", true) || link("stockHistory", "productId", "products");
    if (linkErr) return bad(linkErr + " The backup is incomplete and was not restored.");
    for (const s of b.stores.sales) for (const it of s.items) if (!ids.products.has(it.productId)) return bad("Sale " + s.invoiceNo + " uses a product that is not in the backup.");
    return { ok: true, backup: b };
  }

  function bad(error) { return { ok: false, error: error }; }

  function checkRecord(s, r) {
    const dateKey = (k) => isStr(k) && /^\d{4}-\d{2}-\d{2}$/.test(k);
    switch (s) {
      case "products": return isStr(r.name) && isNum(r.price) && isNum(r.stock) && isNum(r.cost) && isStr(r.status) ? "" : "product details are missing or have the wrong type.";
      case "stockHistory": return isStr(r.productId) && isNum(r.change) ? "" : "stock entry details are missing or have the wrong type.";
      case "sales":
        if (!isStr(r.invoiceNo) || !isNum(r.total) || !isNum(r.amountPaid) || !isNum(r.outstanding) || !isNum(r.subtotal) || !isNum(r.discount) || !isNum(r.cogs)) return "sale amounts are missing or have the wrong type.";
        if (r.status !== "completed" && r.status !== "cancelled") return "sale status is not valid.";
        if (!Array.isArray(r.items) || !r.items.length || !Array.isArray(r.payments)) return "sale items or payments are missing.";
        if (!dateKey(r.dateKey) || !isStr(r.createdAt)) return "sale date is missing.";
        for (const it of r.items) if (!isObj(it) || !isStr(it.productId) || !isNum(it.qty) || !isNum(it.lineTotal)) return "a sale item is not valid.";
        for (const p of r.payments) if (!isObj(p) || !isNum(p.amount) || !isStr(p.method)) return "a sale payment is not valid.";
        return "";
      case "counters": return isNum(r.value) ? "" : "counter value is not a number.";
      case "settings": return "";
      case "customers": return isStr(r.name) && isStr(r.status) ? "" : "customer details are missing.";
      case "ledger": return isStr(r.customerId) && isNum(r.amount) && isStr(r.refKey) && isStr(r.type) && isStr(r.createdAt) && dateKey(r.dateKey) ? "" : "ledger entry details are missing or have the wrong type.";
      case "repayments": return isStr(r.refNo) && isStr(r.customerId) && isNum(r.amount) && Array.isArray(r.allocations) && dateKey(r.dateKey) ? "" : "repayment details are missing or have the wrong type.";
      case "expenses": return Number.isInteger(r.amountP) && r.amountP > 0 && dateKey(r.dateKey) && isStr(r.description) && isStr(r.category) && (r.status === "active" || r.status === "void") ? "" : "expense details are missing or have the wrong type.";
    }
    return "";
  }

  /* ---------- restore (one all-or-nothing transaction) ---------- */

  function replaceAll(backup) {
    return DB.run(STORES, "readwrite", async (tx) => {
      for (const s of STORES) {
        const st = tx.objectStore(s);
        await DB.req(st.clear());
        for (const r of backup.stores[s]) st.add(r); // any failure aborts the whole transaction
      }
    });
  }

  async function reloadScreens() {
    await window.DukaanSettings.reload();
    await window.DukaanProducts.refresh();
    await window.DukaanSales.refresh(); // also reloads customers and the ledger
    await window.DukaanExpenses.refresh();
    const bs = window.DukaanBilling && window.DukaanBilling._state;
    if (bs) { bs.cart = []; bs.customerId = ""; }
    document.dispatchEvent(new CustomEvent("products-changed"));
  }

  /* ---------- screen (uses the panel already in index.html: bkMsg, bkExport, bkFile, bkConfirmBox, bkSummary, bkAck, bkCancel, bkRestore) ---------- */

  const ui = { backup: null, busy: false };

  function setMsg(text, kind) {
    const b = $("bkMsg");
    b.textContent = text || ""; b.hidden = !text;
    b.className = kind === "err" ? "alert" : kind === "ok" ? "note-box" : "muted";
  }

  function total(counts) { return STORES.filter((k) => k !== "counters" && k !== "settings").reduce((a, k) => a + (counts[k] || 0), 0); }

  async function refreshState() {
    try {
      const s = await snapshot();
      const c = {}; STORES.forEach((k) => { c[k] = s[k].length; });
      $("bkExport").disabled = total(c) === 0;
      if (total(c) === 0 && !ui.busy && !ui.backup) setMsg("There is no shop data to back up yet.");
    } catch (e) { $("bkExport").disabled = true; setMsg("Could not read the saved data: " + e.message, "err"); }
  }

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function doExport() {
    if (ui.busy) return;
    ui.busy = true; $("bkExport").disabled = true; setMsg("Preparing your backup…");
    try {
      const b = await buildBackup();
      const name = "dukaan-backup-" + safeName(b.shopName) + "-" + U.dateKey(b.createdAt) + ".json";
      download(name, JSON.stringify(b));
      setMsg("Backup file created: " + name + " (" + STORES.reduce((a, k) => a + b.counts[k], 0) + " records). Check your Downloads folder, then copy it somewhere safe. This app cannot confirm the file was saved.", "ok");
    } catch (e) { setMsg("The backup could not be created: " + e.message, "err"); }
    finally { ui.busy = false; $("bkExport").disabled = false; }
  }

  function resetReview() { ui.backup = null; $("bkConfirmBox").hidden = true; $("bkAck").checked = false; $("bkRestore").disabled = true; $("bkFile").value = ""; }

  async function onFile(e) {
    const f = e.target.files && e.target.files[0];
    ui.backup = null; $("bkConfirmBox").hidden = true; $("bkAck").checked = false; $("bkRestore").disabled = true;
    if (!f) return;
    if (f.size > MAX_BYTES) { setMsg("Cannot restore this file: it is too large to be a backup from this app.", "err"); return; }
    setMsg("Checking the file…");
    let text;
    try { text = await f.text(); } catch (_) { setMsg("The file could not be read. Try selecting it again.", "err"); return; }
    const v = validate(text);
    if (!v.ok) { setMsg("Cannot restore this file. " + v.error + " Your current data was not changed.", "err"); return; }
    ui.backup = v.backup;
    const b = v.backup;
    let cur = null; try { cur = await snapshot(); } catch (_) { /* summary still shown */ }
    const box = $("bkSummary"); box.replaceChildren();
    box.append(el("strong", "", "File: " + f.name), el("div", "", "Shop: " + (b.shopName || "(not named)") + " · made " + U.dateTime(b.createdAt)));
    STORES.forEach((k) => box.append(el("div", "", LABELS[k] + ": " + b.stores[k].length + " in the file" + (cur ? ", " + cur[k].length + " on this device now" : ""))));
    box.append(el("div", "", "Tip: download a backup of your current data first if you may need it."));
    setMsg("");
    $("bkConfirmBox").hidden = false;
  }

  async function doRestore() {
    if (ui.busy || !ui.backup || !$("bkAck").checked) return;
    if (!window.confirm("Replace ALL current shop data with this backup?\n\nProducts, sales, customers, expenses and settings now on this device will be replaced. This cannot be undone.")) return;
    ui.busy = true; $("bkRestore").disabled = true; setMsg("Restoring… do not close this page.");
    const backup = ui.backup;
    try {
      await replaceAll(backup); // committed: all or nothing
    } catch (e) {
      setMsg("Restore failed. Nothing was changed; your previous data is intact. (" + e.message + ")", "err");
      ui.busy = false; $("bkRestore").disabled = !$("bkAck").checked; return;
    }
    try { await reloadScreens(); } catch (_) { /* data is restored; screens reload on next open */ }
    const n = STORES.reduce((a, k) => a + backup.stores[k].length, 0);
    resetReview();
    setMsg("Restore complete: " + n + " records are now in this app.", "ok");
    ui.busy = false;
    refreshState();
  }

  function init() {
    $("bkExport").addEventListener("click", doExport);
    $("bkFile").addEventListener("change", onFile);
    $("bkAck").addEventListener("change", () => { $("bkRestore").disabled = !$("bkAck").checked || ui.busy; });
    $("bkRestore").addEventListener("click", doRestore);
    $("bkCancel").addEventListener("click", () => { resetReview(); setMsg(""); });
    ["sales-changed", "expenses-changed", "products-changed"].forEach((ev) => document.addEventListener(ev, () => { if (!ui.busy) refreshState(); }));
    refreshState();
  }

  document.addEventListener("DOMContentLoaded", init);
  window.DukaanBackup = { validate: validate, buildBackup: buildBackup, replaceAll: replaceAll, STORES: STORES };
})();
