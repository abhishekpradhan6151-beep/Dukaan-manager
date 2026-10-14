/*
 * customers.js - Phase 4: the Customers & Udhaar screens.
 * Screens only. All money rules (balances, repayments, linking) live in js/ledger.js and run inside
 * database transactions there. Nothing here edits a balance; it only asks the ledger to record events.
 * Every piece of user-typed text is put on the page with textContent (via U.el), never as HTML.
 */
(function () {
  "use strict";

  const DB = window.DukaanDB;
  const U = window.DukaanUtil;
  const $ = U.$;
  const el = U.el;
  const L = () => window.DukaanLedger;
  const fmt = (n) => (Number.isInteger(n) ? U.money(n) : U.money2(n));

  const TYPE_LABELS = {
    "opening": "Opening balance",
    "credit-sale": "Credit sale",
    "repayment": "Repayment received",
    "sale-cancel": "Sale cancelled (credit removed)"
  };

  const ui = { selectedId: "", showAll: false };
  const RECENT = 15;

  /* ---------- small helpers ---------- */

  function errorBox(box, msg) { box.textContent = msg || ""; box.hidden = !msg; }

  function ready() {
    const lg = L();
    return lg && lg.status() === "ready";
  }

  function openDialog(d) { if (!d.open) d.showModal(); }

  function btn(label, cls, onClick, aria) {
    const b = el("button", "btn" + (cls ? " " + cls : ""), label);
    b.type = "button";
    if (aria) b.setAttribute("aria-label", aria);
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  function goCustomer(id) { window.location.hash = "#customers/" + encodeURIComponent(id); }

  /* ======================  LIST  ====================== */

  function listRows() {
    const q = $("cuSearch").value.trim().toLowerCase();
    const qd = q.replace(/\D/g, "");
    const st = $("cuStatus").value;
    const owing = $("cuOwing").value;
    let rows = L().customers().map((c) => ({ c: c, bal: L().balance(c.id) }));
    if (st !== "all") rows = rows.filter((r) => r.c.status === st);
    if (q) rows = rows.filter((r) => r.c.name.toLowerCase().includes(q) || (qd && String(r.c.phone || "").replace(/\D/g, "").includes(qd)));
    if (owing === "owing") rows = rows.filter((r) => r.bal > 0);
    if (owing === "clear") rows = rows.filter((r) => r.bal <= 0);
    const sort = $("cuSort").value;
    if (sort === "balance") rows.sort((a, b) => b.bal - a.bal || a.c.name.localeCompare(b.c.name));
    else if (sort === "recent") rows.sort((a, b) => (a.c.createdAt < b.c.createdAt ? 1 : -1));
    else rows.sort((a, b) => a.c.name.localeCompare(b.c.name));
    return rows;
  }

  function renderCards() {
    const wrap = $("cuCards");
    wrap.replaceChildren();
    const lg = L();
    const active = lg.customers().filter((c) => c.status === "active").length;
    const card = (label, value, hint, accent) => {
      const c = el("div", "card" + (accent ? " accent-" + accent : ""));
      c.append(el("div", "card-label", label), el("div", "card-value", value), el("div", "card-hint", hint));
      return c;
    };
    wrap.append(
      card("Total outstanding", fmt(lg.totalOutstanding()), "From the ledger. Cancelled bills are not counted.", "gold"),
      card("Customers owing", String(lg.owingCount()), "With a balance above zero", "warn"),
      card("Repaid today", fmt(lg.repaymentsToday()), "Payments recorded today", "teal"),
      card("Active customers", String(active), "On this device")
    );
  }

  function renderLinkNotice() {
    const box = $("cuLinkNotice");
    box.replaceChildren();
    const list = ready() ? L().unlinked() : [];
    if (!list.length) { box.hidden = true; return; }
    const total = list.reduce((a, s) => a + s.outstanding, 0);
    box.hidden = false;
    box.append(el("strong", "", list.length + (list.length === 1 ? " earlier credit sale is" : " earlier credit sales are") + " not linked to a customer ("
      + U.money2(total) + "). "),
    document.createTextNode("They were made before customer records existed, so they are not in any ledger yet. "));
    const b = btn("Link them to customers", "btn-sm btn-primary", openLink);
    b.id = "cuLink";
    box.append(b);
  }

  function renderList() {
    const wrap = $("cuList");
    wrap.replaceChildren();
    const failed = !L() || L().status() === "failed";
    errorBox($("cuError"), failed ? "Customer records could not be loaded. " + (L() ? L().error() : "") : "");
    if (failed) { $("cuCards").replaceChildren(); $("cuCount").textContent = ""; return; }
    if (!ready()) { wrap.append(el("p", "muted", "Loading…")); return; }
    renderCards();
    renderLinkNotice();

    const all = L().customers();
    const rows = listRows();
    $("cuCount").textContent = rows.length + (rows.length === 1 ? " customer" : " customers");
    if (!all.length) {
      const e = el("div", "empty-state");
      e.append(el("h2", "", "No customers yet"), el("p", "", "Add a customer to give credit (udhaar) and track repayments."));
      const b = btn("+ Add your first customer", "btn-primary", () => openForm({}));
      b.style.marginTop = ".8rem";
      e.append(b);
      wrap.append(e);
      return;
    }
    if (!rows.length) { wrap.append(el("p", "muted", "No customer matches these filters.")); return; }

    const tw = el("div", "table-wrap");
    const table = el("table");
    table.append(el("caption", "sr-only", "Customers"));
    const hr = el("tr");
    ["Name", "Phone", "Status", "Balance owed", "Actions"].forEach((h, i) => { const th = el("th", i === 3 ? "num" : "", h); th.scope = "col"; hr.append(th); });
    const thead = el("thead"); thead.append(hr);
    const tbody = el("tbody");
    const cards = el("div", "tx-list");
    rows.forEach((r) => {
      const c = r.c;
      const act = el("div", "p-actions");
      act.append(btn("Open", "btn-sm", () => goCustomer(c.id), "Open " + c.name));
      if (r.bal > 0) act.append(btn("Receive payment", "btn-sm btn-primary", () => openRepay(c.id), "Receive payment from " + c.name));
      const badge = c.status === "archived" ? el("span", "badge muted", "Archived") : el("span", "badge", "Active");
      const tr = el("tr");
      const stTd = el("td"); stTd.append(badge);
      const actTd = el("td"); actTd.append(act);
      tr.append(el("td", "", c.name), el("td", "", c.phone || "–"), stTd, el("td", "num" + (r.bal > 0 ? " due" : ""), U.money2(r.bal)), actTd);
      tbody.append(tr);

      const item = el("div", "tx-item");
      const left = el("div");
      left.append(el("strong", "", c.name), el("div", "card-hint", c.phone || "No phone"));
      if (c.status === "archived") left.append(el("span", "badge muted", "Archived"));
      const act2 = el("div", "p-actions");
      act2.style.marginTop = ".4rem";
      act2.append(btn("Open", "btn-sm", () => goCustomer(c.id), "Open " + c.name));
      if (r.bal > 0) act2.append(btn("Receive payment", "btn-sm btn-primary", () => openRepay(c.id), "Receive payment from " + c.name));
      left.append(act2);
      const right = el("div");
      right.style.textAlign = "right";
      right.append(el("strong", r.bal > 0 ? "due" : "", U.money2(r.bal)), el("div", "card-hint", r.bal > 0 ? "owed" : "clear"));
      item.append(left, right);
      cards.append(item);
    });
    table.append(thead, tbody);
    tw.append(table);
    wrap.append(tw, cards);
  }

  function exportCustomers() {
    if (!ready()) return;
    const rows = [["Name", "Phone", "Address", "Status", "Balance owed (INR)", "Bills owed", "Added on", "Notes"]];
    L().customers().sort((a, b) => a.name.localeCompare(b.name)).forEach((c) => {
      const s = L().summary(c.id);
      rows.push([c.name, c.phone, c.address, c.status, s.balance.toFixed(2), s.owingBills, U.dateTime(c.createdAt), c.notes]);
    });
    U.downloadCsv("customers.csv", rows);
  }

  /* ======================  ADD / EDIT FORM  ====================== */

  const form = { id: "", editingId: "", busy: false, onSaved: null };
  const FIELDS = ["fcName", "fcPhone", "fcAddress", "fcNotes", "fcOpening"];

  function openForm(opts) {
    opts = opts || {};
    form.onSaved = opts.onSaved || null;
    form.busy = false;
    form.editingId = opts.editId || "";
    form.id = DB.uid(); // one id per opened form: sending it twice cannot create two customers
    const c = form.editingId ? L().getCustomer(form.editingId) : null;
    FIELDS.forEach((f) => { $(f).value = ""; $(f).removeAttribute("aria-invalid"); $("e-" + f).textContent = ""; });
    errorBox($("fcBanner"), "");
    if (c) {
      $("fcTitle").textContent = "Edit customer";
      $("fcName").value = c.name; $("fcPhone").value = c.phone || ""; $("fcAddress").value = c.address || ""; $("fcNotes").value = c.notes || "";
      $("gcOpening").hidden = true;
      $("fcHint").textContent = "The balance comes from the ledger and cannot be typed over here. Changing contact details does not change old bills.";
    } else {
      $("fcTitle").textContent = "Add customer";
      $("fcName").value = opts.name || "";
      $("gcOpening").hidden = false;
      $("fcHint").textContent = "The opening balance is money the customer already owed you before you started using this app. It can only be entered now, when the customer is added.";
    }
    $("fcSave").disabled = false;
    openDialog($("custDialog"));
    $("fcName").focus();
  }

  async function onFormSubmit(e) {
    e.preventDefault();
    if (form.busy) return;
    const isNew = !form.editingId;
    const v = {
      name: $("fcName").value.trim().replace(/\s+/g, " "),
      phone: $("fcPhone").value.trim(),
      address: $("fcAddress").value.trim(),
      notes: $("fcNotes").value.trim(),
      opening: isNew ? $("fcOpening").value.trim() : ""
    };
    const res = L().validateCustomer(v, isNew);
    FIELDS.forEach((f) => {
      const m = res.errs[f] || "";
      $("e-" + f).textContent = m;
      if (m) $(f).setAttribute("aria-invalid", "true"); else $(f).removeAttribute("aria-invalid");
    });
    const bad = FIELDS.find((f) => res.errs[f]);
    if (bad) { $(bad).focus(); return; }

    // Same phone as another customer: warn, but let the shopkeeper go ahead.
    const pk = L().phoneKey(v.phone);
    if (pk) {
      const dup = L().customers().find((c) => c.phoneKey === pk && c.id !== form.editingId);
      if (dup && !window.confirm("A customer with this phone number already exists: " + dup.name + ".\n\nSave this one anyway?")) return;
    }
    if (isNew && res.vals.openingP > 0) {
      if (!window.confirm("Add an opening balance of " + U.money2(res.vals.openingP / 100) + " owed by " + v.name + "?\n\nIt cannot be edited later; a mistake needs a correcting entry.")) return;
    }

    form.busy = true;
    $("fcSave").disabled = true;
    try {
      let c;
      if (isNew) c = await L().createCustomer({ id: form.id, name: v.name, phone: v.phone, address: v.address, notes: v.notes, openingP: res.vals.openingP });
      else c = await L().updateCustomer(form.editingId, v);
      await L().refresh(); // the database has committed; now the screens follow
      $("custDialog").close();
      U.toast(isNew ? "Customer saved: " + c.name : "Customer updated");
      if (form.onSaved) form.onSaved(c);
    } catch (err) {
      errorBox($("fcBanner"), err.message || "Could not save the customer.");
      $("fcSave").disabled = false;
    } finally {
      form.busy = false;
    }
  }

  /* ======================  DETAIL  ====================== */

  function current() { return ui.selectedId ? L().getCustomer(ui.selectedId) : null; }

  function renderDetail() {
    const c = current();
    if (!c) return;
    const lg = L();
    const s = lg.summary(c.id);
    $("cdName").textContent = c.name;
    const badges = $("cdBadges");
    badges.replaceChildren(c.status === "archived" ? el("span", "badge muted", "Archived") : el("span", "badge", "Active"));
    const kv = $("cdContact");
    kv.replaceChildren();
    [["Phone", c.phone || "–"], ["Address", c.address || "–"], ["Notes", c.notes || "–"], ["Added", U.dateTime(c.createdAt)], ["Last changed", U.dateTime(c.updatedAt)]]
      .forEach((p) => kv.append(el("dt", "", p[0]), el("dd", "", p[1])));

    $("cdRepay").disabled = !(s.balance > 0);
    $("cdArchive").textContent = c.status === "archived" ? "Restore customer" : "Archive customer";

    const cards = $("cdCards");
    cards.replaceChildren();
    const card = (label, value, hint, accent) => {
      const d = el("div", "card" + (accent ? " accent-" + accent : ""));
      d.append(el("div", "card-label", label), el("div", "card-value", value), el("div", "card-hint", hint));
      return d;
    };
    cards.append(
      card("Outstanding balance", fmt(s.balance), "Total of this customer’s ledger", s.balance > 0 ? "gold" : "teal"),
      card("Bills still owed", String(s.owingBills), "Including any opening balance"),
      card("Total repaid", fmt(s.repaid), "Money received against credit", "teal")
    );

    renderBills(c);
    renderRepayments(c);
    renderLedger(c);
  }

  function renderBills(c) {
    const wrap = $("cdBills");
    wrap.replaceChildren();
    const items = L().itemsFor(c.id);
    if (!items.length) { wrap.append(el("p", "muted", "Nothing is owed. There are no outstanding bills.")); return; }
    const tw = el("div", "table-wrap always");
    const table = el("table");
    table.append(el("caption", "sr-only", "Outstanding bills"));
    const hr = el("tr");
    ["Bill", "Date", "Credit given", "Repaid", "Still owed", "Actions"].forEach((h, i) => { const th = el("th", i >= 2 && i <= 4 ? "num" : "", h); th.scope = "col"; hr.append(th); });
    const thead = el("thead"); thead.append(hr);
    const tbody = el("tbody");
    items.forEach((it) => {
      const tr = el("tr");
      const label = it.kind === "opening" ? "Opening balance" : it.invoiceNo;
      const act = el("div", "p-actions");
      act.append(btn("Receive payment", "btn-sm btn-primary", () => openRepay(c.id, it.refKey), "Receive payment for " + label));
      if (it.kind === "sale") act.append(btn("View bill", "btn-sm", () => window.DukaanHistory.showSale(it.saleId), "View bill " + label));
      const td = el("td"); td.append(act);
      tr.append(el("td", "", label), el("td", "", U.dateTime(it.createdAt)), el("td", "num", U.money2(it.creditP / 100)),
        el("td", "num", U.money2(it.repaidP / 100)), el("td", "num due", U.money2(it.outP / 100)), td);
      tbody.append(tr);
    });
    table.append(thead, tbody);
    tw.append(table);
    wrap.append(tw);
  }

  function renderRepayments(c) {
    const wrap = $("cdReps");
    wrap.replaceChildren();
    const reps = L().repaymentsFor(c.id);
    if (!reps.length) { wrap.append(el("p", "muted", "No payments received yet.")); return; }
    const tw = el("div", "table-wrap always");
    const table = el("table");
    table.append(el("caption", "sr-only", "Repayments"));
    const hr = el("tr");
    ["Reference", "Date", "Method", "Applied to", "Amount", ""].forEach((h, i) => { const th = el("th", i === 4 ? "num" : "", h); th.scope = "col"; hr.append(th); });
    const thead = el("thead"); thead.append(hr);
    const tbody = el("tbody");
    reps.forEach((r) => {
      const tr = el("tr");
      const td = el("td"); td.append(btn("Slip", "btn-sm", () => showRepaymentReceipt(r), "Open payment slip " + r.refNo));
      tr.append(el("td", "", r.refNo), el("td", "", U.dateTime(r.createdAt)), el("td", "", U.METHODS[r.method] || r.method),
        el("td", "", r.allocations.map((a) => (a.kind === "opening" ? "Opening balance" : a.invoiceNo)).join(", ")),
        el("td", "num", U.money2(r.amount)), td);
      tbody.append(tr);
    });
    table.append(thead, tbody);
    tw.append(table);
    wrap.append(tw);
  }

  function describe(e) {
    const base = TYPE_LABELS[e.type] || e.type;
    const parts = [base];
    if (e.method) parts.push(U.METHODS[e.method] || e.method);
    if (e.notes) parts.push(e.notes);
    return parts.join(" · ");
  }

  // Filtered ledger rows, newest first, each with its running balance (computed over the full ledger).
  function ledgerView(c) {
    const type = $("cdType").value;
    const from = $("cdFrom").value;
    const to = $("cdTo").value;
    let rows = L().ledgerRows(c.id);
    if (type) rows = rows.filter((r) => r.type === type);
    if (from) rows = rows.filter((r) => r.dateKey >= from);
    if (to) rows = rows.filter((r) => r.dateKey <= to);
    return rows.reverse();
  }

  function renderLedger(c) {
    const wrap = $("cdLedger");
    wrap.replaceChildren();
    const rows = ledgerView(c);
    const filtered = $("cdType").value || $("cdFrom").value || $("cdTo").value;
    if (!rows.length) {
      wrap.append(el("p", "muted", filtered ? "No ledger entries match these filters." : "No ledger entries yet. Credit sales and repayments will appear here."));
      $("cdMore").hidden = true;
      return;
    }
    const shown = ui.showAll ? rows : rows.slice(0, RECENT);
    const tw = el("div", "table-wrap always");
    const table = el("table", "ledger");
    table.append(el("caption", "sr-only", "Ledger"));
    const hr = el("tr");
    ["Date and time", "Reference", "Description", "Debit (owed more)", "Credit (paid / removed)", "Running balance"].forEach((h, i) => {
      const th = el("th", i >= 3 ? "num" : "", h); th.scope = "col"; hr.append(th);
    });
    const thead = el("thead"); thead.append(hr);
    const tbody = el("tbody");
    shown.forEach((e) => {
      const tr = el("tr");
      const ref = e.invoiceNo || (e.type === "opening" ? "Opening" : e.repaymentId ? repRef(e.repaymentId) : "");
      tr.append(el("td", "", U.dateTime(e.createdAt)), el("td", "", ref), el("td", "", describe(e)),
        el("td", "num debit", e.amount > 0 ? U.money2(e.amount) : ""),
        el("td", "num credit", e.amount < 0 ? U.money2(-e.amount) : ""),
        el("td", "num", U.money2(e.balanceAfter)));
      tbody.append(tr);
    });
    table.append(thead, tbody);
    tw.append(table);
    wrap.append(tw);
    const more = $("cdMore");
    more.hidden = ui.showAll || rows.length <= RECENT;
    more.textContent = "Show full ledger (" + rows.length + " entries)";
  }

  function repRef(id) { const r = L().repaymentById(id); return r ? r.refNo : ""; }

  function exportLedger() {
    const c = current();
    if (!c) return;
    const rows = [["Date and time", "Type", "Reference", "Description", "Debit (INR)", "Credit (INR)", "Running balance (INR)", "Method"]];
    ledgerView(c).reverse().forEach((e) => {
      rows.push([U.dateTime(e.createdAt), TYPE_LABELS[e.type] || e.type, e.invoiceNo || (e.repaymentId ? repRef(e.repaymentId) : ""), e.notes,
        e.amount > 0 ? e.amount.toFixed(2) : "", e.amount < 0 ? (-e.amount).toFixed(2) : "", e.balanceAfter.toFixed(2), e.method]);
    });
    U.downloadCsv("ledger-" + c.name.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 30) + ".csv", rows);
  }

  async function toggleArchive() {
    const c = current();
    if (!c) return;
    const archiving = c.status !== "archived";
    const bal = L().balance(c.id);
    let msg;
    if (archiving) {
      msg = "Archive " + c.name + "?\n\nTheir bills and ledger stay exactly as they are. They will no longer appear when you pick a customer for a new bill.";
      if (bal > 0) msg += "\n\nWARNING: they still owe " + U.money2(bal) + ". You can still record their repayments after archiving.";
    } else {
      msg = "Restore " + c.name + " so they can be used on new bills again?";
    }
    if (!window.confirm(msg)) return;
    try {
      await L().setCustomerStatus(c.id, archiving ? "archived" : "active");
      await L().refresh();
      U.toast(archiving ? "Customer archived" : "Customer restored");
    } catch (err) {
      U.toast("Could not change the customer: " + err.message);
    }
  }

  /* ======================  REPAYMENT  ====================== */

  const rp = { id: "", customerId: "", items: [], mode: "auto", alloc: {}, busy: false, pending: null };

  function openRepay(customerId, preRef) {
    const c = L().getCustomer(customerId);
    if (!c) return;
    const items = L().itemsFor(customerId);
    if (!items.length) { U.toast(c.name + " owes nothing."); return; }
    rp.id = DB.uid(); // one id per opened form: the same repayment can never be saved twice
    rp.customerId = customerId;
    rp.items = items;
    rp.busy = false;
    rp.pending = null;
    rp.alloc = {};
    rp.mode = preRef ? "manual" : "auto";
    if (preRef) { const it = items.find((x) => x.refKey === preRef); if (it) rp.alloc[preRef] = (it.outP / 100).toFixed(2); }
    const sel = $("rpMethod");
    sel.replaceChildren();
    Object.keys(U.METHODS).forEach((k) => sel.append(new Option(U.METHODS[k], k)));
    $("rpRef").value = ""; $("rpNote").value = "";
    $("rpAmount").value = preRef && rp.alloc[preRef] ? rp.alloc[preRef] : "";
    document.querySelectorAll('input[name="rpMode"]').forEach((r) => { r.checked = r.value === rp.mode; });
    $("rpWho").textContent = c.name + " owes " + U.money2(L().balance(customerId)) + " in total.";
    errorBox($("rpError"), "");
    $("e-rpAmount").textContent = "";
    showStage(1);
    renderAlloc();
    openDialog($("rpDialog"));
    $("rpAmount").focus();
  }

  function showStage(n) {
    $("rpStage1").hidden = n !== 1;
    $("rpStage2").hidden = n !== 2;
    $("rpNext").hidden = n !== 1;
    $("rpBack").hidden = n !== 2;
    $("rpConfirm").hidden = n !== 2;
    $("rpConfirm").disabled = false;
  }

  function itemLabel(it) { return it.kind === "opening" ? "Opening balance" : it.invoiceNo; }

  function manualSumP() {
    return Object.keys(rp.alloc).reduce((a, k) => {
      const n = U.parseMoney(rp.alloc[k]);
      return a + (Number.isNaN(n) ? 0 : Math.round(n * 100));
    }, 0);
  }

  function renderAlloc() {
    const wrap = $("rpAlloc");
    wrap.replaceChildren();
    const manual = rp.mode === "manual";
    $("rpAmount").disabled = manual;
    if (!manual) {
      const n = U.parseMoney($("rpAmount").value);
      if (!Number.isNaN(n) && n > 0) {
        let left = Math.round(n * 100);
        const lines = [];
        rp.items.forEach((it) => { if (left <= 0) return; const p = Math.min(left, it.outP); lines.push(itemLabel(it) + ": " + U.money2(p / 100)); left -= p; });
        if (lines.length && left <= 0) wrap.append(el("p", "card-hint", "Will be applied to: " + lines.join(", ")));
      }
      return;
    }
    wrap.append(el("p", "card-hint", "Enter how much goes to each bill. Leave a bill empty to skip it."));
    rp.items.forEach((it) => {
      const row = el("div", "alloc-row");
      const left = el("div");
      left.append(el("strong", "", itemLabel(it)), el("div", "card-hint", "Owed " + U.money2(it.outP / 100) + " · " + U.dateTime(it.createdAt)));
      const lab = el("label");
      lab.append(el("span", "sr-only", "Amount for " + itemLabel(it)));
      const inp = el("input"); inp.type = "text"; inp.inputMode = "decimal"; inp.autocomplete = "off"; inp.placeholder = "0";
      inp.value = rp.alloc[it.refKey] || ""; inp.dataset.ref = it.refKey;
      lab.append(inp);
      const full = btn("Full", "btn-sm", () => { rp.alloc[it.refKey] = (it.outP / 100).toFixed(2); syncManualAmount(); renderAlloc(); }, "Pay full amount of " + itemLabel(it));
      row.append(left, lab, full);
      wrap.append(row);
    });
    const tot = el("div", "sum-row sum-total");
    tot.append(el("span", "", "Total received"), el("span", "", U.money2(manualSumP() / 100)));
    tot.id = "rpManualTotal";
    wrap.append(tot);
  }

  function syncManualAmount() {
    const p = manualSumP();
    $("rpAmount").value = p > 0 ? (p / 100).toFixed(2) : "";
  }

  // Reads stage 1. Returns { err } or { amount, allocations|null }.
  function readRepay() {
    const totalP = rp.items.reduce((a, it) => a + it.outP, 0);
    if (rp.mode === "manual") {
      const list = [];
      for (const it of rp.items) {
        const raw = String(rp.alloc[it.refKey] || "").trim();
        if (raw === "") continue;
        const n = U.parseMoney(raw);
        if (Number.isNaN(n) || n <= 0) return { err: "Amount for " + itemLabel(it) + " must be above 0, such as 250 or 99.50." };
        if (Math.round(n * 100) > it.outP) return { err: "Only " + U.money2(it.outP / 100) + " is owed on " + itemLabel(it) + "." };
        list.push({ refKey: it.refKey, amount: n, label: itemLabel(it) });
      }
      if (!list.length) return { err: "Enter an amount for at least one bill." };
      const sumP = list.reduce((a, x) => a + Math.round(x.amount * 100), 0);
      return { amount: sumP / 100, allocations: list };
    }
    const n = U.parseMoney($("rpAmount").value);
    if (Number.isNaN(n) || n <= 0) return { err: "Enter the amount received, such as 500 or 250.50." };
    if (Math.round(n * 100) > totalP) return { err: "This customer owes only " + U.money2(totalP / 100) + ". A payment cannot be more than what is owed." };
    return { amount: n, allocations: null };
  }

  function onRepayNext(e) {
    e.preventDefault();
    if (!$("rpStage2").hidden) return;
    $("e-rpAmount").textContent = "";
    const r = readRepay();
    if (r.err) { errorBox($("rpError"), r.err); return; }
    errorBox($("rpError"), "");
    // Work out the allocation lines shown on the review screen (the database recalculates them on save).
    let lines = [];
    if (r.allocations) lines = r.allocations.map((a) => ({ label: a.label, amount: a.amount }));
    else {
      let left = Math.round(r.amount * 100);
      rp.items.forEach((it) => { if (left <= 0) return; const p = Math.min(left, it.outP); lines.push({ label: itemLabel(it), amount: p / 100 }); left -= p; });
    }
    const c = L().getCustomer(rp.customerId);
    const balBeforeP = Math.round(L().balance(rp.customerId) * 100);
    rp.pending = { amount: r.amount, allocations: r.allocations };
    const box = $("rpReview");
    box.replaceChildren();
    const row = (a, b, cls) => { const d = el("div", "sum-row" + (cls ? " " + cls : "")); d.append(el("span", "", a), el("span", "", b)); return d; };
    box.append(row("Customer", c.name), row("Method", U.METHODS[$("rpMethod").value]));
    if ($("rpRef").value.trim()) box.append(row("Payment reference", $("rpRef").value.trim()));
    lines.forEach((l) => box.append(row("Applied to " + l.label, U.money2(l.amount))));
    box.append(row("Amount received", U.money2(r.amount), "sum-total"));
    box.append(row("Balance after saving", U.money2((balBeforeP - Math.round(r.amount * 100)) / 100)));
    box.append(el("p", "card-hint", "This records money you received. It is not a sale and does not change stock or sales totals. It cannot be reversed in this version."));
    showStage(2);
  }

  async function onRepayConfirm() {
    if (rp.busy || !rp.pending) return;
    rp.busy = true;
    $("rpConfirm").disabled = true;
    errorBox($("rpError"), "");
    try {
      const rep = await L().recordRepayment({
        id: rp.id, customerId: rp.customerId, method: $("rpMethod").value, amount: rp.pending.amount,
        reference: $("rpRef").value, note: $("rpNote").value,
        allocations: rp.pending.allocations ? rp.pending.allocations.map((a) => ({ refKey: a.refKey, amount: a.amount })) : null
      });
      await L().refresh(); // committed first, then the screens follow
      $("rpDialog").close();
      U.toast("Payment saved: " + rep.refNo);
      showRepaymentReceipt(rep);
    } catch (err) {
      if (err.code === "DUPLICATE" && err.repayment) {
        await L().refresh();
        $("rpDialog").close();
        U.toast("That payment was already saved. It was not saved twice.");
        showRepaymentReceipt(err.repayment);
      } else {
        // The ledger may have changed since the form opened: reload and let the user review again.
        await L().refresh();
        rp.items = L().itemsFor(rp.customerId);
        rp.alloc = {};
        errorBox($("rpError"), err.message || "The payment could not be saved.");
        showStage(1);
        renderAlloc();
      }
    } finally {
      rp.busy = false;
      $("rpConfirm").disabled = false;
    }
  }

  /* ======================  REPAYMENT SLIP  ====================== */

  let slipRep = null;
  function showRepaymentReceipt(rep) {
    slipRep = rep;
    $("rrPreview").replaceChildren(window.DukaanReceipt.buildRepayment(rep));
    openDialog($("rrDialog"));
  }

  /* ======================  LINK EARLIER CREDIT SALES  ====================== */

  let linkGroups = [];

  function openLink() {
    const list = L().unlinked();
    if (!list.length) { U.toast("There is nothing to link."); return; }
    const map = new Map();
    list.forEach((s) => {
      const name = String(s.customerName || "").trim();
      const key = name.toLowerCase();
      if (!map.has(key)) map.set(key, { name: name, phone: "", sales: [] });
      const g = map.get(key);
      if (!g.phone && s.customerPhone) g.phone = s.customerPhone;
      g.sales.push(s);
    });
    linkGroups = Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
    const wrap = $("lkGroups");
    wrap.replaceChildren();
    const customers = L().customers().filter((c) => c.status === "active").sort((a, b) => a.name.localeCompare(b.name));
    linkGroups.forEach((g, i) => {
      const box = el("div", "link-group");
      const total = g.sales.reduce((a, s) => a + s.outstanding, 0);
      box.append(el("strong", "", g.name || "No name recorded"),
        el("div", "card-hint", g.sales.length + (g.sales.length === 1 ? " bill" : " bills") + " · " + U.money2(total) + " unpaid · " + g.sales.map((s) => s.invoiceNo).join(", ")));
      const lab = el("label");
      lab.append(el("span", "sr-only", "Customer for " + (g.name || "unnamed bills")));
      const sel = el("select"); sel.dataset.idx = i;
      sel.append(new Option("Create a new customer“" + (g.name || "Unnamed customer") + "”", "new"));
      customers.forEach((c) => sel.append(new Option("Use existing: " + c.name + (c.phone ? " (" + c.phone + ")" : ""), c.id)));
      sel.append(new Option("Skip for now", "skip"));
      const match = customers.find((c) => c.nameKey === g.name.toLowerCase());
      if (match) sel.value = match.id;
      lab.append(sel);
      box.append(lab);
      wrap.append(box);
    });
    errorBox($("lkError"), "");
    $("lkSave").disabled = false;
    openDialog($("lkDialog"));
  }

  async function onLinkSubmit(e) {
    e.preventDefault();
    const plan = [];
    $("lkGroups").querySelectorAll("select").forEach((sel) => {
      const g = linkGroups[Number(sel.dataset.idx)];
      if (!g || sel.value === "skip") return;
      plan.push({ saleIds: g.sales.map((s) => s.id), customerId: sel.value === "new" ? null : sel.value, newName: g.name, newPhone: g.phone });
    });
    if (!plan.length) { errorBox($("lkError"), "Nothing selected. Choose a customer, or close this window to skip."); return; }
    const n = plan.reduce((a, g) => a + g.saleIds.length, 0);
    if (!window.confirm("Link " + n + (n === 1 ? " credit sale" : " credit sales") + " to customers?\n\nThis adds their unpaid amounts to those customers’ ledgers. Sale amounts do not change.")) return;
    $("lkSave").disabled = true;
    try {
      const res = await L().linkLegacy(plan);
      await window.DukaanSales.refresh();
      document.dispatchEvent(new CustomEvent("ledger-changed"));
      $("lkDialog").close();
      U.toast("Linked " + res.linked + (res.linked === 1 ? " sale" : " sales") + (res.created ? " · " + res.created + " new customer" + (res.created === 1 ? "" : "s") : ""));
    } catch (err) {
      errorBox($("lkError"), err.message || "Could not link the sales.");
      $("lkSave").disabled = false;
    }
  }

  /* ======================  ROUTING  ====================== */

  function showList() {
    ui.selectedId = "";
    $("cdDetailPane").hidden = true;
    $("cuListPane").hidden = false;
    renderList();
  }

  function showDetail(id) {
    ui.selectedId = id;
    ui.showAll = false;
    $("cdType").value = ""; $("cdFrom").value = ""; $("cdTo").value = "";
    $("cuListPane").hidden = true;
    $("cdDetailPane").hidden = false;
    renderDetail();
  }

  // Called by script.js when the page is "customers" (sub = "" or a customer id).
  function route(sub) {
    if (!ready()) { pendingSub = sub || ""; showList(); return; }
    pendingSub = "";
    let id = "";
    try { id = sub ? decodeURIComponent(sub) : ""; } catch (_) { id = ""; }
    if (id && L().getCustomer(id)) { showDetail(id); $("cdName").focus(); return; }
    if (id) U.toast("That customer was not found.");
    showList();
  }

  let pendingSub = "";
  function rerender() {
    if (pendingSub && ready()) { route(pendingSub); return; }
    const detail = !$("cdDetailPane").hidden;
    if (detail) {
      if (current()) renderDetail(); else showList();
    } else renderList();
  }

  /* ======================  WIRING  ====================== */

  function init() {
    $("cuAdd").addEventListener("click", () => openForm({}));
    $("cuExport").addEventListener("click", exportCustomers);
    ["cuSearch"].forEach((id) => $(id).addEventListener("input", renderList));
    ["cuStatus", "cuOwing", "cuSort"].forEach((id) => $(id).addEventListener("change", renderList));

    $("custForm").addEventListener("submit", onFormSubmit);
    $("fcCancel").addEventListener("click", () => $("custDialog").close());

    $("cdBack").addEventListener("click", () => { window.location.hash = "#customers"; });
    $("cdEdit").addEventListener("click", () => { const c = current(); if (c) openForm({ editId: c.id }); });
    $("cdRepay").addEventListener("click", () => { const c = current(); if (c) openRepay(c.id); });
    $("cdArchive").addEventListener("click", toggleArchive);
    ["cdType", "cdFrom", "cdTo"].forEach((id) => $(id).addEventListener("change", () => { ui.showAll = false; const c = current(); if (c) renderLedger(c); }));
    $("cdMore").addEventListener("click", () => { ui.showAll = true; const c = current(); if (c) renderLedger(c); });
    $("cdLedgerCsv").addEventListener("click", exportLedger);

    $("rpForm").addEventListener("submit", onRepayNext);
    $("rpCancel").addEventListener("click", () => $("rpDialog").close());
    $("rpBack").addEventListener("click", () => { errorBox($("rpError"), ""); showStage(1); });
    $("rpConfirm").addEventListener("click", onRepayConfirm);
    document.querySelectorAll('input[name="rpMode"]').forEach((r) => r.addEventListener("change", () => {
      if (!r.checked) return;
      rp.mode = r.value;
      if (rp.mode === "manual") { rp.alloc = {}; $("rpAmount").value = ""; }
      errorBox($("rpError"), "");
      renderAlloc();
    }));
    $("rpAmount").addEventListener("input", () => { if (rp.mode === "auto") renderAlloc(); });
    $("rpAlloc").addEventListener("input", (e) => {
      const ref = e.target.dataset && e.target.dataset.ref;
      if (!ref) return;
      rp.alloc[ref] = e.target.value;
      syncManualAmount();
      const t = $("rpManualTotal");
      if (t) t.lastChild.textContent = U.money2(manualSumP() / 100);
    });

    $("rrClose").addEventListener("click", () => $("rrDialog").close());
    $("rrPrint").addEventListener("click", () => { if (slipRep) window.DukaanReceipt.printRepayment(slipRep); });

    $("lkForm").addEventListener("submit", onLinkSubmit);
    $("lkCancel").addEventListener("click", () => $("lkDialog").close());

    document.addEventListener("ledger-changed", rerender);
    document.addEventListener("sales-changed", () => { if ($("cdDetailPane").hidden) renderLinkNotice(); });
    renderList();
  }

  document.addEventListener("DOMContentLoaded", init);
  window.DukaanCustomers = { openForm: openForm, openRepay: openRepay, route: route, showRepaymentReceipt: showRepaymentReceipt };
})();