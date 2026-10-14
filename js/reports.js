/*
 * reports.js - Phase 5: date-filtered reports, calculated only from saved records (no sample values).
 * Money is added up in integer paise. Rules:
 *  - Sales = completed (not cancelled) sales dated in the range. Total includes tax.
 *  - Payments received are shown separately: money taken on those sales, and customer repayments.
 *    Repayments are never part of sales. Payments on cancelled sales are not counted (any refund is up to the shopkeeper).
 *  - Outstanding credit = the customer ledger total today (not date-filtered), plus unlinked earlier credit.
 *  - Gross profit = sales before tax, minus discount, minus cost of goods. It is shown only when every
 *    sale line in the range has a saved cost; otherwise it is marked unavailable.
 *  - Net operating result = gross profit - active expenses, only when gross profit is reliable.
 */
(function () {
  "use strict";

  const U = window.DukaanUtil;
  const $ = U.$;
  const el = U.el;
  const toP = (r) => Math.round(r * 100);

  const addDays = (key, n) => { const d = new Date(key + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  function rangeFor(kind, from, to) {
    const today = U.todayKey();
    if (kind === "today") return { from: today, to: today };
    if (kind === "week") { // Monday to today
      const dow = new Date(today + "T00:00:00Z").getUTCDay();
      return { from: addDays(today, -((dow + 6) % 7)), to: today };
    }
    if (kind === "month") return { from: today.slice(0, 8) + "01", to: today };
    return { from: from, to: to };
  }

  // Pure calculation over the given records (also used by the tests).
  function compute(sales, repayments, expenses, range, ledgerTotalP, unlinkedP) {
    const inR = (k) => k >= range.from && k <= range.to;
    const live = sales.filter((s) => s.status === "completed" && inR(s.dateKey));
    let salesP = 0, atSaleP = 0, subtotalNetP = 0, cogsP = 0, costMissingBills = 0;
    live.forEach((s) => {
      salesP += toP(s.total);
      atSaleP += toP(s.amountPaid);
      subtotalNetP += toP(s.subtotal) - toP(s.discount);
      cogsP += toP(s.cogs);
      if ((s.items || []).some((i) => i.costMissing)) costMissingBills += 1;
    });
    const repaid = repayments.filter((r) => inR(r.dateKey));
    const repaidP = repaid.reduce((a, r) => a + toP(r.amount), 0);
    const exp = expenses.filter((e) => e.status === "active" && inR(e.dateKey));
    const expP = exp.reduce((a, e) => a + e.amountP, 0);
    const byCat = {};
    exp.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + e.amountP; });
    const grossReliable = live.length > 0 && costMissingBills === 0;
    const grossP = subtotalNetP - cogsP;
    return {
      bills: live.length, salesP: salesP, atSaleP: atSaleP, repaidP: repaidP, receivedP: atSaleP + repaidP,
      expensesP: expP, expenseCount: exp.length, byCat: byCat,
      grossReliable: grossReliable, grossP: grossP, costMissingBills: costMissingBills,
      netP: grossReliable ? grossP - expP : null,
      creditP: ledgerTotalP, unlinkedP: unlinkedP
    };
  }

  function current() {
    const kind = $("rpKind").value;
    const r = rangeFor(kind, $("rpFrom").value, $("rpTo").value);
    return { kind: kind, range: r };
  }

  function card(label, value, hint, accent) {
    const c = el("div", "card" + (accent ? " accent-" + accent : ""));
    c.append(el("div", "card-label", label), el("div", "card-value", value), el("div", "card-hint", hint));
    return c;
  }
  const m = (p) => U.money2(p / 100);

  function render() {
    const wrap = $("rpCards"); wrap.replaceChildren();
    const box = $("rpCat"); box.replaceChildren();
    const custom = $("rpKind").value === "custom";
    $("rpCustom").hidden = !custom;
    const S = window.DukaanSales, L = window.DukaanLedger, X = window.DukaanExpenses;
    const ready = S && L && X && S.status() === "ready" && L.status() === "ready" && X.status() === "ready";
    if (!ready) {
      const bad = [S, L, X].some((x) => x && x.status() === "failed");
      $("rpNote").textContent = bad ? "Some saved data could not be loaded, so reports are unavailable." : "Loading…";
      return;
    }
    const { range } = current();
    if (!range.from || !range.to) { $("rpNote").textContent = "Choose both a From and a To date."; return; }
    if (range.from > range.to) { $("rpNote").textContent = "The From date is after the To date."; return; }
    $("rpNote").textContent = "Showing " + range.from + " to " + range.to + " (Indian dates).";
    const unlinkedP = L.unlinked().reduce((a, s) => a + toP(s.outstanding), 0);
    const r = compute(S.cached(), L.repayments(), X.list(), range, toP(L.totalOutstanding()), unlinkedP);

    wrap.append(
      card("Total sales", m(r.salesP), r.bills + (r.bills === 1 ? " bill" : " bills") + ", cancelled bills excluded. Includes tax."),
      card("Received on these bills", m(r.atSaleP), "Cash, UPI, card, bank recorded at sale", "teal"),
      card("Repayments received", m(r.repaidP), "Udhaar collected. Not sales revenue.", "teal"),
      card("Total money received", m(r.receivedP), "Sale payments plus repayments", "teal"),
      card("Expenses", m(r.expensesP), r.expenseCount + (r.expenseCount === 1 ? " expense" : " expenses") + ", voided ones excluded", "gold"),
      r.grossReliable
        ? card("Gross profit", m(r.grossP), "Sales before tax, minus discount and cost of goods")
        : card("Gross profit", "Unavailable", r.bills === 0 ? "No sales in this period" : r.costMissingBills + " bill(s) have items with no saved cost", "warn"),
      r.grossReliable
        ? card("Net operating result", m(r.netP), r.netP < 0 ? "Loss for the period: gross profit minus expenses" : "Gross profit minus expenses", r.netP < 0 ? "warn" : "")
        : card("Net operating result", "Unavailable", "Needs a reliable gross profit", "warn"),
      card("Customer credit outstanding", m(r.creditP), "Total owed today from customer ledgers (not limited to this period)", "gold")
    );
    if (r.unlinkedP > 0) wrap.append(card("Unlinked earlier credit", m(r.unlinkedP), "Not in the ledger. Link it on the Customers page.", "warn"));

    if (r.expenseCount) {
      box.append(el("h3", "", "Expenses by category"));
      Object.keys(r.byCat).sort((a, b) => r.byCat[b] - r.byCat[a]).forEach((k) => {
        const row = el("div", "sum-row"); row.append(el("span", "", k), el("span", "", m(r.byCat[k]))); box.append(row);
      });
    }
  }

  function init() {
    $("rpKind").addEventListener("change", () => {
      const kind = $("rpKind").value;
      if (kind !== "custom") { const r = rangeFor(kind); $("rpFrom").value = r.from; $("rpTo").value = r.to; }
      render();
    });
    ["rpFrom", "rpTo"].forEach((id) => $(id).addEventListener("input", render));
    ["sales-changed", "ledger-changed", "expenses-changed"].forEach((ev) => document.addEventListener(ev, render));
    $("rpFrom").value = $("rpTo").value = U.todayKey();
    render();
  }

  document.addEventListener("DOMContentLoaded", init);
  window.DukaanReports = { compute: compute, rangeFor: rangeFor };
})();
