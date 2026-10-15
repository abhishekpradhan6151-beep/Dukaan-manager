/*
 * expenses.js - Phase 5: expense records and the Expenses screen.
 * Money is stored as integer paise in `amountP`. Expenses are never deleted: a wrong one is VOIDED
 * (status "void", reason and time kept) and an edit is logged in the record's `events`.
 * Every write is one IndexedDB transaction through DukaanDB.run; success shows only after commit.
 */
(function () {
  "use strict";

  const DB = window.DukaanDB;
  const U = window.DukaanUtil;
  const $ = U.$;
  const el = U.el;

  const CATEGORIES = ["Rent", "Electricity", "Salary", "Transport", "Supplies", "Maintenance", "Other"];
  const toP = (r) => Math.round(r * 100);
  const validDate = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && !Number.isNaN(Date.parse(k + "T00:00:00Z")) && new Date(k + "T00:00:00Z").toISOString().slice(0, 10) === k;

  let cache = [];
  let status = "loading";
  let lastError = "";
  const fm = { id: "", editId: "", busy: false };

  function fail(msg, code) { const e = new Error(msg); if (code) e.code = code; return e; }

  // raw form values -> { errs: {fieldId: msg}, v }
  function validate(raw) {
    const errs = {};
    const desc = raw.description.trim().replace(/\s+/g, " ");
    if (!desc) errs.exDesc = "Enter what the expense was for.";
    else if (desc.length > 120) errs.exDesc = "Description is too long (max 120 characters).";
    if (!CATEGORIES.includes(raw.category)) errs.exCategory = "Choose a category.";
    const amt = U.parseMoney(raw.amount);
    if (Number.isNaN(amt) || amt <= 0) errs.exAmount = "Enter an amount above 0, such as 1500 or 249.50.";
    if (!validDate(raw.date)) errs.exDate = "Choose a valid date.";
    else if (raw.date > U.todayKey()) errs.exDate = "The date cannot be in the future.";
    if (!U.METHODS[raw.method]) errs.exMethod = "Choose how it was paid.";
    if (raw.notes.length > 300) errs.exNotes = "Notes are too long (max 300 characters).";
    return { errs: errs, v: { description: desc, category: raw.category, amountP: Number.isNaN(amt) ? 0 : toP(amt), date: raw.date, method: raw.method, notes: raw.notes.trim() } };
  }

  function create(input) {
    return DB.run(["expenses"], "readwrite", async (tx) => {
      const store = tx.objectStore("expenses");
      const dup = await DB.req(store.get(input.id));
      if (dup) return dup; // same form id = same expense: never saved twice
      const at = DB.now();
      const rec = {
        id: input.id, date: input.date, dateKey: input.date, description: input.description, category: input.category,
        amountP: input.amountP, method: input.method, notes: input.notes, status: "active",
        createdAt: at, updatedAt: at, events: [{ type: "created", at: at }]
      };
      store.add(rec);
      return rec;
    });
  }

  function update(id, f) {
    return DB.run(["expenses"], "readwrite", async (tx) => {
      const store = tx.objectStore("expenses");
      const cur = await DB.req(store.get(id));
      if (!cur) throw fail("Expense not found.");
      if (cur.status !== "active") throw fail("A voided expense cannot be edited.", "VOID");
      const at = DB.now();
      const changed = ["description", "category", "amountP", "date", "method", "notes"].filter((k) => cur[k] !== f[k]);
      if (!changed.length) return cur;
      const before = {}; changed.forEach((k) => { before[k] = cur[k]; });
      Object.assign(cur, { description: f.description, category: f.category, amountP: f.amountP, date: f.date, dateKey: f.date, method: f.method, notes: f.notes, updatedAt: at });
      cur.events = (cur.events || []).concat([{ type: "edited", at: at, before: before }]);
      store.put(cur);
      return cur;
    });
  }

  function voidExpense(id, reason) {
    return DB.run(["expenses"], "readwrite", async (tx) => {
      const store = tx.objectStore("expenses");
      const cur = await DB.req(store.get(id));
      if (!cur) throw fail("Expense not found.");
      if (cur.status === "void") throw fail("This expense is already voided.", "VOID"); // second void refused
      const at = DB.now();
      cur.status = "void"; cur.voidedAt = at; cur.voidReason = reason; cur.updatedAt = at;
      cur.events = (cur.events || []).concat([{ type: "voided", at: at, reason: reason }]);
      store.put(cur);
      return cur;
    });
  }

  async function refresh() {
    try {
      cache = (await DB.run(["expenses"], "readonly", (tx) => DB.req(tx.objectStore("expenses").getAll())))
        .filter((e) => e && typeof e.amountP === "number" && validDate(e.dateKey)); // skip malformed records
      cache.sort((a, b) => (a.dateKey === b.dateKey ? (a.createdAt < b.createdAt ? 1 : -1) : a.dateKey < b.dateKey ? 1 : -1));
      status = "ready"; lastError = "";
    } catch (e) { status = "failed"; lastError = e.message; }
    document.dispatchEvent(new CustomEvent("expenses-changed"));
  }

  // Active (not voided) expenses between two date keys, inclusive.
  const inRange = (from, to) => cache.filter((e) => e.status === "active" && e.dateKey >= from && e.dateKey <= to);
  const totalP = (rows) => rows.reduce((a, e) => a + e.amountP, 0);

  /* ---------- screen ---------- */

  function filtered() {
    const q = $("exSearch").value.trim().toLowerCase();
    const cat = $("exCat").value, st = $("exStatus").value, from = $("exFrom").value, to = $("exTo").value;
    return cache.filter((e) => (st === "all" || e.status === st) && (!cat || e.category === cat) && (!from || e.dateKey >= from) && (!to || e.dateKey <= to)
      && (!q || (e.description + " " + e.notes + " " + e.category).toLowerCase().includes(q)));
  }

  function btn(label, cls, fn, aria) { const b = el("button", "btn " + cls, label); b.type = "button"; b.addEventListener("click", fn); if (aria) b.setAttribute("aria-label", aria); return b; }

  function render() {
    const wrap = $("exList");
    wrap.replaceChildren();
    const failed = status === "failed";
    $("exError").hidden = !failed; $("exError").textContent = failed ? "Expenses could not be loaded. " + lastError : "";
    if (failed) { $("exCount").textContent = ""; return; }
    if (status !== "ready") { wrap.append(el("p", "muted", "Loading…")); return; }
    const rows = filtered();
    const act = rows.filter((e) => e.status === "active");
    $("exCount").textContent = rows.length + (rows.length === 1 ? " expense" : " expenses") + " · active total " + U.money2(totalP(act) / 100);
    if (!cache.length) {
      const e = el("div", "empty-state");
      e.append(el("h2", "", "No expenses recorded"), el("p", "", "Rent, electricity, wages and other shop costs you record will appear here."));
      const b = btn("+ Add your first expense", "btn-primary", () => openForm()); b.style.marginTop = ".8rem"; e.append(b);
      wrap.append(e); return;
    }
    if (!rows.length) { wrap.append(el("p", "muted", "No expense matches these filters.")); return; }
    const tw = el("div", "table-wrap");
    const table = el("table");
    table.append(el("caption", "sr-only", "Expenses"));
    const hr = el("tr");
    ["Date", "Description", "Category", "Paid by", "Amount", "Actions"].forEach((h, i) => { const th = el("th", i === 4 ? "num" : "", h); th.scope = "col"; hr.append(th); });
    const thead = el("thead"); thead.append(hr);
    const tbody = el("tbody"); const list = el("div", "tx-list");
    rows.forEach((e) => {
      const voided = e.status === "void";
      const acts = el("div", "p-actions");
      acts.append(btn("Details", "btn-sm", () => showDetail(e.id), "Details of expense " + e.description));
      if (!voided) acts.append(btn("Edit", "btn-sm", () => openForm(e.id), "Edit expense " + e.description));
      const tr = el("tr", voided ? "voided" : "");
      const dTd = el("td"); dTd.append(el("span", "", e.description)); if (voided) dTd.append(document.createTextNode(" "), el("span", "badge out", "Void"));
      const aTd = el("td"); aTd.append(acts);
      tr.append(el("td", "", e.dateKey), dTd, el("td", "", e.category), el("td", "", U.METHODS[e.method] || e.method), el("td", "num", U.money2(e.amountP / 100)), aTd);
      tbody.append(tr);
      const item = el("div", "tx-item" + (voided ? " voided" : ""));
      const left = el("div"); left.append(el("strong", "", e.description), el("div", "card-hint", e.dateKey + " · " + e.category + " · " + (U.METHOD_SHORT[e.method] || e.method)));
      if (voided) left.append(el("span", "badge out", "Void"));
      const a2 = el("div", "p-actions"); a2.style.marginTop = ".4rem";
      a2.append(btn("Details", "btn-sm", () => showDetail(e.id)));
      if (!voided) a2.append(btn("Edit", "btn-sm", () => openForm(e.id)));
      left.append(a2);
      const right = el("div"); right.style.textAlign = "right"; right.append(el("strong", "", U.money2(e.amountP / 100)));
      item.append(left, right); list.append(item);
    });
    table.append(thead, tbody); tw.append(table); wrap.append(tw, list);
  }

  const FIELDS = ["exDesc", "exCategory", "exAmount", "exDate", "exMethod", "exNotes"];

  function openForm(editId) {
    fm.busy = false; fm.editId = editId || ""; fm.id = DB.uid();
    const e = editId ? cache.find((x) => x.id === editId) : null;
    FIELDS.forEach((f) => { $(f).removeAttribute("aria-invalid"); $("e-" + f).textContent = ""; });
    $("exBanner").hidden = true;
    const cs = $("exCategory"); cs.replaceChildren(); CATEGORIES.forEach((c) => cs.append(new Option(c, c)));
    const ms = $("exMethod"); ms.replaceChildren(); Object.keys(U.METHODS).forEach((k) => ms.append(new Option(U.METHODS[k], k)));
    $("exTitle").textContent = e ? "Edit expense" : "Add expense";
    $("exDesc").value = e ? e.description : ""; cs.value = e ? e.category : "Other";
    $("exAmount").value = e ? (e.amountP / 100).toFixed(2) : ""; $("exDate").value = e ? e.dateKey : U.todayKey();
    ms.value = e ? e.method : "cash"; $("exNotes").value = e ? e.notes : "";
    $("exVoid").hidden = !e; $("exSave").disabled = false;
    $("expDialog").showModal(); $("exDesc").focus();
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    if (fm.busy) return;
    const r = validate({ description: $("exDesc").value, category: $("exCategory").value, amount: $("exAmount").value, date: $("exDate").value, method: $("exMethod").value, notes: $("exNotes").value });
    FIELDS.forEach((f) => { $("e-" + f).textContent = r.errs[f] || ""; if (r.errs[f]) $(f).setAttribute("aria-invalid", "true"); else $(f).removeAttribute("aria-invalid"); });
    const bad = FIELDS.find((f) => r.errs[f]);
    if (bad) { $(bad).focus(); return; }
    fm.busy = true; $("exSave").disabled = true;
    try {
      if (fm.editId) await update(fm.editId, r.v); else await create(Object.assign({ id: fm.id }, r.v));
      await refresh(); // committed first, then the screens follow
      $("expDialog").close();
      U.toast(fm.editId ? "Expense updated" : "Expense saved");
    } catch (err) {
      $("exBanner").textContent = err.message || "Could not save the expense."; $("exBanner").hidden = false; $("exSave").disabled = false;
    } finally { fm.busy = false; }
  }

  async function onVoid() {
    if (fm.busy || !fm.editId) return;
    const reason = await U.ask("Void this expense? It stays in the history but no longer counts in reports.\n\nType a reason (required):", "Void expense", true);
    if (reason === null) return;
    if (!reason.trim()) { $("exBanner").textContent = "A reason is required to void an expense."; $("exBanner").hidden = false; return; }
    fm.busy = true;
    try { await voidExpense(fm.editId, reason.trim().slice(0, 200)); await refresh(); $("expDialog").close(); U.toast("Expense voided"); }
    catch (err) { $("exBanner").textContent = err.message; $("exBanner").hidden = false; }
    finally { fm.busy = false; }
  }

  function showDetail(id) {
    const e = cache.find((x) => x.id === id); if (!e) return;
    $("exdTitle").textContent = e.description;
    const kv = $("exdInfo"); kv.replaceChildren();
    [["Date", e.dateKey], ["Category", e.category], ["Amount", U.money2(e.amountP / 100)], ["Paid by", U.METHODS[e.method] || e.method], ["Notes", e.notes || "–"],
      ["Status", e.status === "void" ? "Void: " + (e.voidReason || "") : "Active"], ["Recorded", U.dateTime(e.createdAt)]].forEach((p) => kv.append(el("dt", "", p[0]), el("dd", "", p[1])));
    const h = $("exdHist"); h.replaceChildren();
    (e.events || []).slice().reverse().forEach((ev) => {
      let t = ev.type === "created" ? "Recorded" : ev.type === "voided" ? "Voided: " + ev.reason : "Edited (changed: " + Object.keys(ev.before || {}).join(", ") + ")";
      h.append(el("li", "", U.dateTime(ev.at) + " · " + t));
    });
    $("exdDialog").showModal();
  }

  function init() {
    $("exAdd").addEventListener("click", () => openForm());
    $("exForm").addEventListener("submit", onSubmit);
    $("exCancel").addEventListener("click", () => $("expDialog").close());
    $("exVoid").addEventListener("click", onVoid);
    $("exdClose").addEventListener("click", () => $("exdDialog").close());
    ["exSearch", "exFrom", "exTo"].forEach((id) => $(id).addEventListener("input", render));
    ["exCat", "exStatus"].forEach((id) => $(id).addEventListener("change", render));
    $("exClear").addEventListener("click", () => { $("exSearch").value = ""; $("exFrom").value = ""; $("exTo").value = ""; $("exCat").value = ""; $("exStatus").value = "active"; render(); });
    const c = $("exCat"); CATEGORIES.forEach((x) => c.append(new Option(x, x)));
    document.addEventListener("expenses-changed", render);
    refresh();
  }

  document.addEventListener("DOMContentLoaded", init);
  window.DukaanExpenses = { CATEGORIES: CATEGORIES, validate: validate, create: create, update: update, voidExpense: voidExpense, refresh: refresh,
    list: () => cache.slice(), inRange: inRange, totalP: totalP, status: () => status, error: () => lastError, openAdd: () => openForm() };
})();
