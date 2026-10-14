/*
 * billing.js - Phase 3: the New Sale screen.
 * This file only reads the screen and calls DukaanSales.complete(). The
 * database checks (stock, price, duplicate bill) happen again inside that
 * transaction, so a stale screen can never oversell or double-save.
 *
 * The bill being built is kept in memory in `state`, so switching to another
 * page and back does not lose it. Reloading the page does (a warning is shown).
 */
(function () {
  "use strict";

  const DB = window.DukaanDB;
  const U = window.DukaanUtil;
  const $ = U.$;
  const el = U.el;

  // saleId is created when a bill is started. Saving the same id twice is refused by the database.
  // A new bill starts with one "cash, paid in full" row (it follows the bill total). Change it, or tap "All on credit".
  const defaultPayments = () => [{ method: "cash", amount: "", auto: true }];
  const state = { cart: [], payments: defaultPayments(), saleId: DB.uid(), busy: false, customerId: "" };
  const L = () => window.DukaanLedger;

  const products = () => (window.DukaanProducts ? window.DukaanProducts.list() : []);
  const byId = (id) => products().find((p) => p.id === id);
  const isDecimal = (unit) => window.DukaanProducts.isDecimalUnit(unit);
  const settings = () => (window.DukaanSettings ? window.DukaanSettings.get() : { prefix: "INV" });

  /* ---------- reading the screen ---------- */

  function cartLines() {
    return state.cart.map((item) => {
      const p = byId(item.productId);
      const q = U.parseQty(item.qty);
      let err = "";
      if (!p) err = "This product is no longer available.";
      else if (p.status !== "active") err = "This product is archived and cannot be sold.";
      else if (Number.isNaN(q) || q <= 0) err = "Enter a quantity above 0.";
      else if (!isDecimal(p.unit) && !Number.isInteger(q)) err = "Use a whole number for " + p.unit + ".";
      else if (q > p.stock) err = "Only " + U.qty(p.stock, p.unit) + " in stock.";
      return { item: item, p: p, q: q, err: err };
    });
  }

  function readExtras() {
    const type = $("sDiscType").value;
    const rawD = $("sDiscValue").value.trim();
    let dValue = 0, dErr = "";
    if (rawD !== "") {
      dValue = type === "percent" ? U.parsePercent(rawD) : U.parseMoney(rawD);
      if (Number.isNaN(dValue)) { dErr = type === "percent" ? "Discount % must be between 0 and 100." : "Enter the discount as an amount such as 50 or 12.50."; dValue = 0; }
    }
    const rawT = $("sTax").value.trim();
    let tax = 0, tErr = "";
    if (rawT !== "") {
      tax = U.parsePercent(rawT);
      if (Number.isNaN(tax)) { tErr = "Tax % must be between 0 and 100."; tax = 0; }
    }
    return { discount: { type: type, value: dValue }, tax: tax, dErr: dErr, tErr: tErr };
  }

  function currentTotals(lines, extras) {
    const usable = lines.filter((l) => l.p && Number.isFinite(l.q) && l.q > 0)
      .map((l) => ({ qty: l.q, unitPrice: l.p.price, cost: l.p.cost }));
    return window.DukaanSales.calc(usable, extras.discount, extras.tax);
  }

  // A single "paid in full" row follows the bill total automatically until the user edits it.
  function syncAutoPayment(total) {
    if (state.payments.length === 1 && state.payments[0].auto) {
      state.payments[0].amount = total > 0 ? total.toFixed(2) : "";
    }
  }

  function paymentInfo() {
    let paidP = 0;
    const errs = [];
    const list = [];
    state.payments.forEach((row, i) => {
      const a = U.parseMoney(row.amount);
      if (Number.isNaN(a) || a <= 0) { errs.push("Payment " + (i + 1) + ": enter an amount above 0, or remove the row."); return; }
      paidP += Math.round(a * 100);
      list.push({ method: row.method, amount: a });
    });
    return { paidP: paidP, errs: errs, list: list };
  }

  /* ---------- drawing ---------- */

  function showMessages(list) {
    const b = $("sBanner");
    b.replaceChildren();
    if (!list || !list.length) { b.hidden = true; return; }
    if (list.length === 1) b.textContent = list[0];
    else {
      b.append(el("strong", "", "Please fix these first:"));
      const ul = el("ul");
      list.forEach((m) => ul.append(el("li", "", m)));
      b.append(ul);
    }
    b.hidden = false;
  }

  function renderResults() {
    const wrap = $("sResults");
    wrap.replaceChildren();
    const st = window.DukaanProducts && window.DukaanProducts.stats();
    if (st && st.failed) { wrap.append(el("p", "alert", "Storage is unavailable, so billing is turned off.")); return; }
    const all = products().filter((p) => p.status === "active");
    if (!all.length) {
      wrap.append(el("p", "muted", "No active products yet. Add products on the Products page first."));
      return;
    }
    const q = $("sSearch").value.trim().toLowerCase();
    let list = q ? all.filter((p) => [p.name, p.sku, p.barcode].join(" ").toLowerCase().includes(q)) : all.slice();
    list.sort((a, b) => a.name.localeCompare(b.name));
    list = list.slice(0, 8);
    if (!list.length) { wrap.append(el("p", "muted", "No product matches “" + $("sSearch").value.trim() + "”.")); return; }
    list.forEach((p) => {
      const row = el("div", "result");
      const left = el("div");
      left.append(el("strong", "", p.name),
        el("div", "card-hint", [p.sku ? "SKU " + p.sku : "", U.money(p.price) + " per " + p.unit, "Stock " + U.qty(p.stock, p.unit)].filter(Boolean).join(" · ")));
      const b = el("button", "btn btn-sm" + (p.stock > 0 ? " btn-primary" : ""), p.stock > 0 ? "Add" : "Out of stock");
      b.type = "button";
      b.dataset.add = p.id;
      b.disabled = p.stock <= 0;
      b.setAttribute("aria-label", (p.stock > 0 ? "Add " : "Out of stock: ") + p.name);
      row.append(left, b);
      wrap.append(row);
    });
  }

  function renderCart() {
    const wrap = $("sCart");
    wrap.replaceChildren();
    if (!state.cart.length) { wrap.append(el("p", "muted", "No items yet. Search above and tap Add.")); return; }
    cartLines().forEach((l, i) => {
      const name = l.p ? l.p.name : "Unavailable item";
      const unit = l.p ? l.p.unit : "";
      const row = el("div", "cart-row");
      const top = el("div", "cart-top");
      const left = el("div");
      left.append(el("strong", "", name));
      if (l.p) left.append(el("div", "card-hint", U.money(l.p.price) + " per " + unit + " · In stock " + U.qty(l.p.stock, unit)));
      const lineTotal = l.p && Number.isFinite(l.q) && l.q > 0 ? window.DukaanSales.calc([{ qty: l.q, unitPrice: l.p.price, cost: 0 }], null, 0).subtotal : 0;
      top.append(left, el("strong", "", l.p ? U.money2(lineTotal) : "–"));

      const ctl = el("div", "cart-ctl");
      const dec = el("button", "btn btn-sm qty-btn", "−"); dec.type = "button"; dec.dataset.act = "dec"; dec.dataset.idx = i; dec.setAttribute("aria-label", "Decrease quantity of " + name);
      const inc = el("button", "btn btn-sm qty-btn", "+"); inc.type = "button"; inc.dataset.act = "inc"; inc.dataset.idx = i; inc.setAttribute("aria-label", "Increase quantity of " + name);
      const input = el("input", "qty-input"); input.type = "text"; input.inputMode = "decimal"; input.autocomplete = "off";
      input.value = l.item.qty; input.dataset.idx = i; input.setAttribute("aria-label", "Quantity of " + name + (unit ? " in " + unit : ""));
      if (l.err) input.setAttribute("aria-invalid", "true");
      const del = el("button", "btn btn-sm", "Remove"); del.type = "button"; del.dataset.act = "del"; del.dataset.idx = i; del.setAttribute("aria-label", "Remove " + name + " from bill");
      ctl.append(dec, input, inc, el("span", "card-hint", unit), del);
      row.append(top, ctl);
      if (l.err) row.append(el("div", "err", l.err));
      wrap.append(row);
    });
  }

  function renderPayments() {
    const wrap = $("sPayRows");
    wrap.replaceChildren();
    state.payments.forEach((row, i) => {
      const r = el("div", "pay-row");
      const mLabel = el("label");
      mLabel.append(el("span", "sr-only", "Payment method " + (i + 1)));
      const sel = el("select"); sel.dataset.idx = i; sel.dataset.field = "method";
      Object.keys(U.METHODS).forEach((k) => { const o = new Option(U.METHODS[k], k); if (k === row.method) o.selected = true; sel.append(o); });
      mLabel.append(sel);
      const aLabel = el("label");
      aLabel.append(el("span", "sr-only", "Amount received " + (i + 1)));
      const inp = el("input"); inp.type = "text"; inp.inputMode = "decimal"; inp.autocomplete = "off"; inp.placeholder = "Amount (₹)";
      inp.value = row.amount; inp.dataset.idx = i; inp.dataset.field = "amount";
      aLabel.append(inp);
      const del = el("button", "btn btn-sm", "Remove"); del.type = "button"; del.dataset.act = "delpay"; del.dataset.idx = i; del.setAttribute("aria-label", "Remove payment " + (i + 1));
      r.append(mLabel, aLabel, del);
      wrap.append(r);
    });
    if (!state.payments.length) wrap.append(el("p", "muted", "No payment received: the whole bill will be on credit (udhaar)."));
  }

  /* ---------- customer picker ---------- */

  function selectedCustomer() {
    if (!state.customerId || !L()) return null;
    return L().getCustomer(state.customerId);
  }

  function renderCustomer() {
    const sel = $("sCustSelected");
    const picker = $("sCustPicker");
    sel.replaceChildren();
    const c = selectedCustomer();
    if (state.customerId && !c) state.customerId = "";
    if (c) {
      picker.hidden = true;
      sel.hidden = false;
      const info = el("div");
      info.append(el("strong", "", c.name));
      if (c.phone) info.append(el("div", "card-hint", c.phone));
      const bal = L().balance(c.id);
      info.append(el("div", "card-hint", bal > 0 ? "Already owes " + U.money2(bal) : "No balance due"));
      const rm = el("button", "btn btn-sm", "Remove customer");
      rm.type = "button"; rm.id = "sCustRemove";
      sel.append(info, rm);
    } else {
      sel.hidden = true;
      picker.hidden = false;
      renderCustomerResults();
    }
  }

  function renderCustomerResults() {
    const wrap = $("sCustResults");
    wrap.replaceChildren();
    if (!L() || L().status() === "failed") { wrap.append(el("p", "err", "Customer records could not be loaded.")); return; }
    const q = $("sCustSearch").value.trim().toLowerCase();
    if (!q) { wrap.append(el("p", "card-hint", "Type a name or phone number to find a customer. Leave empty for a walk-in sale.")); return; }
    const qd = q.replace(/\D/g, "");
    const list = L().customers().filter((c) => c.status === "active" &&
      (c.name.toLowerCase().includes(q) || (qd && String(c.phone || "").replace(/\D/g, "").includes(qd)))).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 6);
    if (!list.length) { wrap.append(el("p", "muted", "No customer matches. Use “+ New customer”.")); return; }
    list.forEach((c) => {
      const row = el("div", "result");
      const left = el("div");
      left.append(el("strong", "", c.name));
      const bal = L().balance(c.id);
      left.append(el("div", "card-hint", [c.phone, bal > 0 ? "Owes " + U.money2(bal) : ""].filter(Boolean).join(" · ")));
      const b = el("button", "btn btn-sm", "Select");
      b.type = "button"; b.dataset.pick = c.id;
      b.setAttribute("aria-label", "Select customer " + c.name);
      row.append(left, b);
      wrap.append(row);
    });
  }

  function sumRow(label, value, cls) {
    const r = el("div", "sum-row" + (cls ? " " + cls : ""));
    r.append(el("span", "", label), el("span", "", value));
    return r;
  }

  function renderSummary() {
    const lines = cartLines();
    const extras = readExtras();
    const t = currentTotals(lines, extras);
    syncAutoPayment(t.total);
    // keep the visible amount of an automatic row in step with the total
    if (state.payments.length === 1 && state.payments[0].auto) {
      const inp = $("sPayRows").querySelector('input[data-field="amount"]');
      if (inp) inp.value = state.payments[0].amount;
    }
    const pi = paymentInfo();
    const due = Math.max(0, t.totalP - pi.paidP) / 100;

    $("e-sDisc").textContent = extras.dErr || (t.discountTooHigh ? "Discount is more than the subtotal." : "");
    $("e-sTax").textContent = extras.tErr;

    const box = $("sSummary");
    box.replaceChildren();
    box.append(sumRow("Subtotal", U.money2(t.subtotal)));
    if (t.discount > 0) box.append(sumRow("Discount", "− " + U.money2(t.discount)));
    if (t.tax > 0) box.append(sumRow("Tax (" + extras.tax + "%)", U.money2(t.tax)));
    box.append(sumRow("Bill total", U.money2(t.total), "sum-total"));
    box.append(sumRow("Received now", U.money2(pi.paidP / 100)));
    box.append(sumRow("On credit (udhaar)", U.money2(due), due > 0 ? "sum-due" : ""));
    if (pi.paidP > t.totalP) box.append(el("div", "err", "Payments are more than the bill total."));
    if (due > 0) box.append(el("div", "card-hint", selectedCustomer() ? "Credit will be added to " + selectedCustomer().name + "’s udhaar ledger." : "Credit needs a customer. Select or add one above."));
  }

  function renderAll() {
    renderResults();
    renderCart();
    renderCustomer();
    renderPayments();
    renderSummary();
  }

  /* ---------- actions ---------- */

  function addToCart(id) {
    const p = byId(id);
    if (!p || p.status !== "active" || p.stock <= 0) return;
    const existing = state.cart.find((c) => c.productId === id);
    if (existing) {
      const q = U.parseQty(existing.qty);
      existing.qty = String(U.round((Number.isNaN(q) ? 0 : q) + 1, 3));
    } else {
      state.cart.push({ productId: id, qty: "1" });
    }
    showMessages([]);
    renderCart();
    renderSummary();
  }

  function newBill() {
    state.cart = [];
    state.payments = defaultPayments();
    state.saleId = DB.uid();
    $("sDiscType").value = "amount";
    state.customerId = "";
    ["sDiscValue", "sTax", "sCustSearch", "sSearch"].forEach((id) => { $(id).value = ""; });
    showMessages([]);
    renderAll();
  }

  function validateBill() {
    const errs = [];
    const lines = cartLines();
    if (!lines.length) errs.push("Add at least one product.");
    lines.forEach((l) => { if (l.err) errs.push((l.p ? l.p.name : "Item") + ": " + l.err); });
    const extras = readExtras();
    if (extras.dErr) errs.push(extras.dErr);
    if (extras.tErr) errs.push(extras.tErr);
    const t = currentTotals(lines, extras);
    if (t.discountTooHigh) errs.push("The discount cannot be more than the subtotal.");
    if (lines.length && t.totalP <= 0) errs.push("The bill total must be more than zero.");
    const pi = paymentInfo();
    if (lines.length) pi.errs.forEach((m) => errs.push(m));
    if (pi.paidP > t.totalP) errs.push("Payments (" + U.money2(pi.paidP / 100) + ") are more than the bill total (" + U.money2(t.total) + ").");
    const dueP = t.totalP - pi.paidP;
    const cust = selectedCustomer();
    if (dueP > 0 && !cust) errs.push("Select or add a customer: " + U.money2(dueP / 100) + " will be on credit (udhaar).");
    if (cust && cust.status !== "active") errs.push("This customer is archived. Restore them on the Customers page first.");
    const items = lines.filter((l) => !l.err && l.p).map((l) => ({ productId: l.p.id, qty: l.q, unitPrice: l.p.price }));
    return { errs: errs, items: items, extras: extras, payments: pi.list, customer: cust, dueP: Math.max(0, dueP), totalP: t.totalP };
  }

  function setBusy(busy) {
    state.busy = busy;
    const b = $("sComplete");
    b.disabled = busy;
    b.textContent = busy ? "Saving…" : "Complete sale";
  }

  async function onComplete() {
    if (state.busy) return; // ignores repeated clicks while a save is running
    const v = validateBill();
    if (v.errs.length) { showMessages(v.errs); return; }
    showMessages([]);
    if (v.dueP > 0) {
      // credit adds to what the customer owes, so the shopkeeper confirms it first
      const ok = window.confirm("Put " + U.money2(v.dueP / 100) + " on credit (udhaar) for " + v.customer.name + "?\n\nThis adds to the amount they owe you.");
      if (!ok) return;
    }
    setBusy(true);
    try {
      const sale = await window.DukaanSales.complete({
        id: state.saleId, items: v.items, discount: v.extras.discount, taxRate: v.extras.tax,
        payments: v.payments, customerId: v.customer ? v.customer.id : "", prefix: settings().prefix
      });
      // The database has committed. Only now do we confirm and clear the bill.
      newBill();
      document.dispatchEvent(new CustomEvent("stock-changed"));
      await window.DukaanSales.refresh();
      U.toast("Sale saved: " + sale.invoiceNo);
      window.DukaanHistory.showSale(sale.id, { justSaved: true });
    } catch (err) {
      if (err.code === "DUPLICATE" && err.sale) {
        newBill();
        document.dispatchEvent(new CustomEvent("stock-changed"));
        await window.DukaanSales.refresh();
        window.DukaanHistory.showSale(err.sale.id, { justSaved: true, duplicate: true });
      } else {
        showMessages([err.message]);
        document.dispatchEvent(new CustomEvent("stock-changed")); // reload products so the screen matches the database
      }
    } finally {
      setBusy(false);
    }
  }

  /* ---------- wiring ---------- */

  function onSearchKey(e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = $("sSearch").value.trim().toLowerCase();
    if (!q) return;
    const active = products().filter((p) => p.status === "active");
    const exact = active.find((p) => (p.barcode && p.barcode.toLowerCase() === q) || (p.sku && p.sku.toLowerCase() === q));
    const hit = exact || active.filter((p) => [p.name, p.sku, p.barcode].join(" ").toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name))[0];
    if (!hit) return;
    if (hit.stock <= 0) { showMessages(["“" + hit.name + "” is out of stock."]); return; }
    addToCart(hit.id);
    $("sSearch").value = "";
    renderResults();
  }

  function init() {
    $("sResults").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-add]");
      if (b) addToCart(b.dataset.add);
    });
    $("sSearch").addEventListener("input", renderResults);
    $("sSearch").addEventListener("keydown", onSearchKey);

    $("sCart").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      const i = Number(b.dataset.idx);
      const item = state.cart[i];
      if (!item) return;
      if (b.dataset.act === "del") {
        state.cart.splice(i, 1);
      } else {
        const q = U.parseQty(item.qty);
        if (b.dataset.act === "inc") item.qty = String(U.round((Number.isNaN(q) ? 0 : q) + 1, 3));
        if (b.dataset.act === "dec" && !Number.isNaN(q) && q - 1 > 0) item.qty = String(U.round(q - 1, 3));
      }
      renderCart();
      renderSummary();
    });
    $("sCart").addEventListener("change", (e) => {
      const input = e.target.closest("input.qty-input");
      if (!input) return;
      const item = state.cart[Number(input.dataset.idx)];
      if (!item) return;
      item.qty = input.value.trim();
      renderCart();
      renderSummary();
    });

    ["sDiscType", "sDiscValue", "sTax"].forEach((id) => $(id).addEventListener("input", renderSummary));
    $("sDiscType").addEventListener("change", renderSummary);

    $("sPayCash").addEventListener("click", () => { state.payments = [{ method: "cash", amount: "", auto: true }]; renderPayments(); renderSummary(); });
    $("sPayUpi").addEventListener("click", () => { state.payments = [{ method: "upi", amount: "", auto: true }]; renderPayments(); renderSummary(); });
    $("sPayCredit").addEventListener("click", () => { state.payments = []; renderPayments(); renderSummary(); });
    $("sPayAdd").addEventListener("click", () => {
      state.payments.forEach((r) => { r.auto = false; });
      const t = currentTotals(cartLines(), readExtras());
      const remaining = Math.max(0, t.totalP - paymentInfo().paidP) / 100;
      state.payments.push({ method: "cash", amount: remaining > 0 ? remaining.toFixed(2) : "", auto: false });
      renderPayments();
      renderSummary();
    });
    $("sPayRows").addEventListener("click", (e) => {
      const b = e.target.closest('button[data-act="delpay"]');
      if (!b) return;
      state.payments.splice(Number(b.dataset.idx), 1);
      renderPayments();
      renderSummary();
    });
    $("sPayRows").addEventListener("input", (e) => {
      const f = e.target.dataset.field;
      const row = state.payments[Number(e.target.dataset.idx)];
      if (!row) return;
      if (f === "amount") { row.amount = e.target.value; row.auto = false; renderSummary(); }
    });
    $("sPayRows").addEventListener("change", (e) => {
      const row = state.payments[Number(e.target.dataset.idx)];
      if (row && e.target.dataset.field === "method") row.method = e.target.value;
    });

    $("sComplete").addEventListener("click", onComplete);
    $("sClear").addEventListener("click", () => {
      if (!state.cart.length) { newBill(); return; }
      if (window.confirm("Clear this bill? The items and payments you entered will be removed.")) newBill();
    });

    document.addEventListener("products-changed", renderAll);
    document.addEventListener("ledger-changed", () => { renderCustomer(); renderSummary(); });

    $("sCustSearch").addEventListener("input", renderCustomerResults);
    $("sCustResults").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-pick]");
      if (!b) return;
      state.customerId = b.dataset.pick;
      $("sCustSearch").value = "";
      renderCustomer();
      renderSummary();
    });
    $("sCustSelected").addEventListener("click", (e) => {
      if (!e.target.closest("#sCustRemove")) return;
      state.customerId = "";
      renderCustomer();
      renderSummary();
    });
    // Add a customer without losing the bill: the bill lives in `state`, and the form is a dialog on top.
    $("sCustNew").addEventListener("click", () => {
      window.DukaanCustomers.openForm({
        name: $("sCustSearch").value.trim(),
        onSaved: (c) => { state.customerId = c.id; $("sCustSearch").value = ""; renderCustomer(); renderSummary(); }
      });
    });

    // Do not lose a half-finished bill by accident.
    window.addEventListener("beforeunload", (e) => {
      if (state.cart.length) { e.preventDefault(); e.returnValue = ""; }
    });

    renderAll();
  }

  document.addEventListener("DOMContentLoaded", init);
  window.DukaanBilling = { _state: state };
})();