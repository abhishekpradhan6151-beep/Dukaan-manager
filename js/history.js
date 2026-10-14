/*
 * history.js - Phase 3: Sales History screen, sale details, reprinting and
 * cancellation. Sales are never edited or deleted; a cancelled sale stays in
 * the list with its status, reason and time.
 */
(function () {
  "use strict";

  const U = window.DukaanUtil;
  const $ = U.$;
  const el = U.el;
  const PAGE_SIZE = 50;

  const state = { shown: PAGE_SIZE, currentId: null, busy: false };

  /* ---------- list ---------- */

  function filtered() {
    const q = $("hSearch").value.trim().toLowerCase();
    const from = $("hFrom").value, to = $("hTo").value;
    const method = $("hMethod").value, status = $("hStatus").value;
    return window.DukaanSales.cached().filter((s) => {
      if (q && !(s.invoiceNo.toLowerCase().includes(q) || (s.customerName || "").toLowerCase().includes(q))) return false;
      if (from && s.dateKey < from) return false;
      if (to && s.dateKey > to) return false;
      // "Has credit due" means unpaid TODAY (repayments count, cancelled bills do not)
      if (method === "credit") { if (!(window.DukaanLedger.dueForSale(s) > 0)) return false; }
      else if (method && !s.payments.some((p) => p.method === method)) return false;
      if (status && s.status !== status) return false;
      return true;
    });
  }

  function statusBadge(s) {
    const b = U.paymentSummary(s, window.DukaanLedger.dueForSale(s));
    return el("span", "badge" + (b.cls ? " " + b.cls : ""), s.status === "cancelled" ? "Cancelled" : b.label);
  }

  function viewButton(s) {
    const b = el("button", "btn btn-sm", "View");
    b.type = "button";
    b.dataset.view = s.id;
    b.setAttribute("aria-label", "View invoice " + s.invoiceNo);
    return b;
  }

  function renderList() {
    const wrap = $("hList");
    wrap.replaceChildren();
    $("hMore").hidden = true;
    const st = window.DukaanSales.status();
    if (st === "failed") { $("hError").textContent = window.DukaanSales.error() + " Sales history is unavailable."; $("hError").hidden = false; $("hCount").textContent = ""; return; }
    $("hError").hidden = true;
    if (st !== "ready") { $("hCount").textContent = "Loading sales…"; return; }

    const all = window.DukaanSales.cached();
    if (!all.length) {
      $("hCount").textContent = "";
      const e = el("div", "empty-state");
      e.append(el("h2", "", "No sales recorded yet"), el("p", "", "Completed bills will be listed here, newest first."));
      const b = el("button", "btn btn-primary", "+ Make your first sale"); b.type = "button"; b.dataset.go = "sale"; b.style.marginTop = ".8rem";
      e.append(b);
      wrap.append(e);
      return;
    }
    const list = filtered();
    $("hCount").textContent = list.length + (list.length === 1 ? " sale" : " sales") + " shown (of " + all.length + " saved)";
    if (!list.length) {
      const e = el("div", "empty-state");
      e.append(el("h2", "", "No sales match"), el("p", "", "Try a different search, date range or filter."));
      wrap.append(e);
      return;
    }
    const page = list.slice(0, state.shown);
    const tw = el("div", "table-wrap");
    const table = el("table");
    table.append(el("caption", "sr-only", "Sales history"));
    const thead = el("thead"), hr = el("tr");
    ["Invoice", "Date & time", "Customer", "Total", "Paid", "Due", "Status", "Actions"].forEach((h, i) => {
      const th = el("th", i >= 3 && i <= 5 ? "num" : "", h); th.scope = "col"; hr.append(th);
    });
    thead.append(hr);
    const tbody = el("tbody");
    const cards = el("div", "tx-list");
    page.forEach((s) => {
      const due = window.DukaanLedger.dueForSale(s); // 0 for fully paid, cleared and cancelled bills
      const tr = el("tr");
      const stTd = el("td"); stTd.append(statusBadge(s));
      const actTd = el("td"); actTd.append(viewButton(s));
      tr.append(el("td", "", s.invoiceNo), el("td", "", U.dateTime(s.createdAt)), el("td", "", s.customerName || "Walk-in"),
        el("td", "num", U.money2(s.total)), el("td", "num", U.money2(s.amountPaid)), el("td", "num", due > 0 ? U.money2(due) : "–"),
        stTd, actTd);
      tbody.append(tr);

      const c = el("div", "p-card");
      const top = el("div", "p-card-top");
      const left = el("div");
      left.append(el("strong", "", s.invoiceNo), el("div", "card-hint", s.customerName || "Walk-in"), el("div", "card-hint", U.dateTime(s.createdAt)));
      const right = el("div"); right.style.textAlign = "right";
      right.append(el("strong", "", U.money2(s.total)));
      const bl = el("div"); bl.append(statusBadge(s)); right.append(bl);
      if (due > 0) right.append(el("div", "card-hint", "Due " + U.money2(due)));
      top.append(left, right);
      const act = el("div", "p-actions"); act.append(viewButton(s));
      c.append(top, act);
      cards.append(c);
    });
    table.append(thead, tbody);
    tw.append(table);
    wrap.append(tw, cards);
    $("hMore").hidden = list.length <= state.shown;
  }

  /* ---------- sale details ---------- */

  function showSale(id, opts) {
    opts = opts || {};
    const s = window.DukaanSales.getCached(id);
    if (!s) { U.toast("That sale could not be found."); return; }
    state.currentId = id;
    $("sdTitle").textContent = "Invoice " + s.invoiceNo;

    const banner = $("sdBanner");
    banner.className = "note-box";
    if (opts.duplicate) banner.textContent = "This bill was already saved. It was not saved a second time.";
    else if (opts.justSaved) banner.textContent = "Sale saved. Stock has been updated. You can print the receipt below.";
    else if (s.status === "cancelled") banner.textContent = "This sale was cancelled. Stock was returned" + (s.outstanding > 0 ? " and the unpaid credit was removed from the customer’s ledger." : ".");
    else banner.textContent = "";
    banner.hidden = !banner.textContent;

    $("sdPreview").replaceChildren(window.DukaanReceipt.build(s, "compact"));

    const audit = $("sdAudit");
    audit.replaceChildren();
    const EVENT_LABELS = { created: "Created", cancelled: "Cancelled", "linked-customer": "Linked to customer ledger" };
    const ul = el("ul", "hist");
    s.events.forEach((ev) => {
      const li = el("li");
      li.append(el("strong", "", EVENT_LABELS[ev.type] || ev.type));
      li.append(el("div", "card-hint", U.dateTime(ev.at)));
      if (ev.reason) li.append(el("div", "", "Reason: " + ev.reason));
      ul.append(li);
    });
    audit.append(ul);

    // Credit (udhaar) on this sale: what was unpaid, what has been repaid, what is due now.
    if (s.outstanding > 0) {
      const L = window.DukaanLedger;
      const box = el("div", "note-box");
      box.id = "sdCredit";
      box.append(el("strong", "", "Credit (udhaar)"));
      const kv = el("dl", "kv");
      const add = (k, v) => kv.append(el("dt", "", k), el("dd", "", v));
      add("Customer", s.customerName || "Not linked to a customer yet");
      add("Credit at sale", U.money2(s.outstanding));
      const c = L.saleCredit(s);
      if (s.customerId) add("Repaid since", U.money2(c.repaid));
      if (s.status === "cancelled") {
        const cc = s.cancellation || {};
        add("Credit cancelled", U.money2(cc.creditReversed != null ? cc.creditReversed : s.outstanding));
        add("Due now", U.money2(0));
      } else {
        add("Due now", U.money2(c.dueNow));
      }
      box.append(kv);
      if (s.customerId) {
        const b = el("button", "btn btn-sm", "View customer ledger");
        b.type = "button"; b.id = "sdViewCustomer"; b.dataset.customer = s.customerId;
        box.append(b);
      } else {
        box.append(el("p", "card-hint", "This sale was made before customer ledgers existed. Link it from Customers & Udhaar."));
      }
      audit.append(box);
    }
    if (s.status === "cancelled") {
      const cc = s.cancellation || {};
      const received = cc.refundDue != null ? cc.refundDue : s.amountPaid;
      if (received > 0) {
        audit.append(el("p", "muted", "Money the shop received on this sale was " + U.money2(received) + (cc.repaidSinceSale > 0 ? " (including " + U.money2(cc.repaidSinceSale) + " repaid by the customer later)" : "") + ". Refund it to the customer yourself; this app only records the cancellation."));
      }
    }

    $("sdCancel").hidden = s.status !== "completed";
    if (!$("saleDialog").open) $("saleDialog").showModal();
  }

  /* ---------- cancellation ---------- */

  function openCancel() {
    const s = window.DukaanSales.getCached(state.currentId);
    if (!s || s.status !== "completed") return;
    $("cancelForm").reset();
    $("e-cReason").textContent = "";
    $("cReason").removeAttribute("aria-invalid");
    $("cError").hidden = true;
    $("cTitle").textContent = "Cancel invoice " + s.invoiceNo + "?";
    // say exactly what this does to the customer's credit
    const info = $("cInfo");
    if (s.outstanding > 0 && s.customerId) {
      const c = window.DukaanLedger.saleCredit(s);
      let msg = U.money2(c.dueNow) + " still unpaid on this bill will be removed from " + s.customerName + "’s ledger.";
      if (c.repaid > 0) msg += " The customer has already repaid " + U.money2(c.repaid) + " on this bill; you must refund that yourself.";
      info.textContent = msg;
      info.hidden = false;
    } else if (s.outstanding > 0) {
      info.textContent = "This earlier credit sale is not linked to a customer ledger, so no ledger entry changes.";
      info.hidden = false;
    } else {
      info.hidden = true;
    }
    $("cancelDialog").showModal();
    $("cReason").focus();
  }

  async function onCancelSubmit(e) {
    e.preventDefault();
    if (state.busy) return;
    const reason = $("cReason").value.trim();
    if (reason.length < 3) {
      $("e-cReason").textContent = "Enter a reason (at least 3 characters).";
      $("cReason").setAttribute("aria-invalid", "true");
      $("cReason").focus();
      return;
    }
    state.busy = true;
    $("cConfirm").disabled = true;
    $("cError").hidden = true;
    try {
      await window.DukaanSales.cancel(state.currentId, reason);
      $("cancelDialog").close();
      document.dispatchEvent(new CustomEvent("stock-changed"));
      await window.DukaanSales.refresh();
      showSale(state.currentId);
      U.toast("Sale cancelled. Stock returned.");
    } catch (err) {
      $("cError").textContent = err.message;
      $("cError").hidden = false;
      if (err.code === "ALREADY_CANCELLED") await window.DukaanSales.refresh();
    } finally {
      state.busy = false;
      $("cConfirm").disabled = false;
    }
  }

  /* ---------- wiring ---------- */

  function resetPaging() { state.shown = PAGE_SIZE; renderList(); }

  function init() {
    ["hSearch", "hFrom", "hTo", "hMethod", "hStatus"].forEach((id) => {
      $(id).addEventListener(id === "hSearch" ? "input" : "change", resetPaging);
    });
    $("hMore").addEventListener("click", () => { state.shown += PAGE_SIZE; renderList(); });
    $("hClear").addEventListener("click", () => {
      ["hSearch", "hFrom", "hTo"].forEach((id) => { $(id).value = ""; });
      $("hMethod").value = ""; $("hStatus").value = "";
      resetPaging();
    });
    $("hList").addEventListener("click", (e) => {
      const v = e.target.closest("button[data-view]");
      if (v) { showSale(v.dataset.view); return; }
      const g = e.target.closest("button[data-go]");
      if (g) window.location.hash = "#" + g.dataset.go;
    });

    $("sdClose").addEventListener("click", () => $("saleDialog").close());
    $("sdPrint").addEventListener("click", () => {
      const s = window.DukaanSales.getCached(state.currentId);
      if (s) window.DukaanReceipt.print(s, "compact");
    });
    $("sdPrintA4").addEventListener("click", () => {
      const s = window.DukaanSales.getCached(state.currentId);
      if (s) window.DukaanReceipt.print(s, "a4");
    });
    $("sdCancel").addEventListener("click", openCancel);
    $("cancelForm").addEventListener("submit", onCancelSubmit);
    $("cBack").addEventListener("click", () => $("cancelDialog").close());

    document.addEventListener("sales-changed", renderList);
    document.addEventListener("ledger-changed", renderList);
    $("saleDialog").addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest("#sdViewCustomer");
      if (!btn) return;
      const id = btn.dataset.customer;
      $("saleDialog").close();
      window.location.hash = "#customers/" + encodeURIComponent(id);
    });
    renderList();
  }

  document.addEventListener("DOMContentLoaded", init);
  window.DukaanHistory = { showSale: showSale };
})();
