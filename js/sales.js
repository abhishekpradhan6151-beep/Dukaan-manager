/*
 * sales.js - Phase 3 & 4: sales data, business rules, and customer credit integration.
 *
 * Money is calculated in paise (whole numbers) so there are no rounding
 * surprises like 0.1 + 0.2. Results are stored in rupees with 2 decimals.
 *
 * A sale is saved by complete(): ONE database transaction that
 *   1. refuses a bill id that was already saved (no duplicate sales),
 *   2. re-checks every product (exists, active, price unchanged, enough stock),
 *   3. validates customer if attached or required for credit,
 *   4. takes the next invoice number,
 *   5. reduces stock exactly once and writes stock history,
 *   6. creates customer ledger entry if credit is created,
 *   7. saves the sale with its line items and payments.
 * If anything fails, nothing is saved. Success is reported only after commit.
 *
 * A sale is never edited or deleted. cancel() marks it "cancelled", puts the
 * stock back exactly once, reverses active credit in the customer ledger,
 * and records who/why/when in the sale's event log.
 */
(function () {
  "use strict";

  const DB = window.DukaanDB;
  const U = window.DukaanUtil;

  const toPaise = (rupees) => Math.round(rupees * 100);
  // quantity (up to 3 decimals) x price per unit, rounded to the nearest paisa
  const linePaise = (qty, price) => Math.round(Math.round(qty * 1000) * toPaise(price) / 1000);

  /*
   * calc(lines, discount, taxRate)
   *   lines    [{ qty, unitPrice, cost }]
   *   discount { type: "amount" | "percent", value }   (optional)
   *   taxRate  percent added on top of the discounted amount (0 = no tax)
   * Formulas:
   *   subtotal = sum of line totals
   *   taxable  = subtotal - discount
   *   tax      = taxable x rate
   *   total    = taxable + tax
   *   cogs     = sum of qty x cost (cost of goods sold, from the cost snapshot)
   */
  function calc(lines, discount, taxRate) {
    let sub = 0, cogs = 0, costMissing = false;
    lines.forEach((l) => {
      sub += linePaise(l.qty, l.unitPrice);
      cogs += linePaise(l.qty, l.cost || 0);
      if (!(l.cost > 0)) costMissing = true;
    });
    let disc = 0;
    if (discount && discount.value > 0) {
      disc = discount.type === "percent"
        ? Math.round(sub * Math.round(discount.value * 100) / 10000)
        : toPaise(discount.value);
    }
    const discountTooHigh = disc > sub;
    const taxable = Math.max(0, sub - disc);
    const tax = taxRate > 0 ? Math.round(taxable * Math.round(taxRate * 100) / 10000) : 0;
    const total = taxable + tax;
    return {
      subtotal: sub / 100, discount: disc / 100, taxable: taxable / 100, tax: tax / 100,
      total: total / 100, cogs: cogs / 100,
      subtotalP: sub, discountP: disc, totalP: total,
      discountTooHigh: discountTooHigh, costMissing: costMissing
    };
  }

  function fail(message, code, extra) {
    const e = new Error(message);
    if (code) e.code = code;
    if (extra) Object.assign(e, extra);
    return e;
  }

  // Same product on two cart lines becomes one line.
  function mergeItems(items) {
    const map = new Map();
    items.forEach((it) => {
      const cur = map.get(it.productId);
      if (cur) cur.qty = U.round(cur.qty + it.qty, 3);
      else map.set(it.productId, { productId: it.productId, qty: it.qty, unitPrice: it.unitPrice });
    });
    return Array.from(map.values());
  }

  function stockEntry(p, before, after, type, reason, at) {
    return {
      id: DB.uid(), productId: p.id, productName: p.name, type: type,
      change: U.round(after - before, 3), before: before, after: after,
      reason: reason, note: "", createdAt: at
    };
  }

  /*
   * complete(input)
   *   id            bill id made when the bill was started (same id = same bill)
   *   items         [{ productId, qty, unitPrice }]   unitPrice = price the cashier saw
   *   discount      { type, value }
   *   taxRate       percent (0 = off)
   *   payments      [{ method, amount }]   money received now
   *   customerId, customerName, customerPhone, prefix
   * Resolves with the saved sale AFTER the transaction has committed.
   */
  function complete(input) {
    const items = mergeItems(input.items || []);
    const prefix = (input.prefix || "INV").toUpperCase();
    const customerId = input.customerId || null;
    const customerName = (input.customerName || "").trim().slice(0, 80);
    const customerPhone = (input.customerPhone || "").trim().slice(0, 20);
    const taxRate = Number(input.taxRate) || 0;

    return DB.run(["products", "stockHistory", "sales", "counters", "customers", "customerLedger"], "readwrite", async (tx) => {
      const salesStore = tx.objectStore("sales");
      const prodStore = tx.objectStore("products");
      const custStore = tx.objectStore("customers");
      const ledgerStore = tx.objectStore("customerLedger");

      // 1. Same bill id already saved? Then do nothing and say so.
      const existing = await DB.req(salesStore.get(input.id));
      if (existing) {
        throw fail("This bill was already saved as " + existing.invoiceNo + ". It was not saved a second time.", "DUPLICATE", { sale: existing });
      }
      if (!items.length) throw fail("The bill has no items.");

      // 2. Check customer if attached or required.
      let attachedCust = null;
      if (customerId) {
        attachedCust = await DB.req(custStore.get(customerId));
        if (!attachedCust) throw fail("The selected customer was not found in database.");
      }

      // 3. Check every product against the database (not the screen).
      const checked = [];
      for (const it of items) {
        const p = await DB.req(prodStore.get(it.productId));
        if (!p) throw fail("A product on this bill no longer exists.");
        if (p.status !== "active") throw fail("“" + p.name + "” is archived and cannot be sold.");
        if (!(it.qty > 0)) throw fail("Quantity for “" + p.name + "” must be more than 0.");
        const decimalOk = window.DukaanProducts ? window.DukaanProducts.isDecimalUnit(p.unit) : false;
        if (!decimalOk && !Number.isInteger(it.qty)) throw fail("“" + p.name + "” is sold in whole numbers only.");
        if (p.price !== it.unitPrice) {
          throw fail("The price of “" + p.name + "” changed. Please review the bill and try again.", "PRICE_CHANGED");
        }
        if (p.stock < it.qty) {
          throw fail("Not enough stock for “" + p.name + "”. Available: " + U.qty(p.stock, p.unit) + ", needed: " + U.qty(it.qty, p.unit) + ".", "INSUFFICIENT_STOCK");
        }
        checked.push({ p: p, qty: it.qty });
      }

      // 4. Totals, from database prices and cost snapshots.
      const lines = checked.map((c) => ({
        productId: c.p.id, name: c.p.name, sku: c.p.sku, unit: c.p.unit, qty: c.qty,
        unitPrice: c.p.price, costSnapshot: c.p.cost, costMissing: !(c.p.cost > 0),
        lineTotal: linePaise(c.qty, c.p.price) / 100
      }));
      const t = calc(lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, cost: l.costSnapshot })), input.discount, taxRate);
      if (t.discountTooHigh) throw fail("The discount is more than the subtotal.");
      if (t.totalP <= 0) throw fail("The bill total must be more than zero.");

      // 5. Payments received now. Whatever is not paid stays as credit (udhaar).
      const at = DB.now();
      const payments = [];
      let paidP = 0;
      for (const pay of (input.payments || [])) {
        const amt = Number(pay.amount);
        if (!U.METHODS[pay.method]) throw fail("Unknown payment method.");
        if (!Number.isFinite(amt) || amt <= 0 || Math.abs(amt * 100 - Math.round(amt * 100)) > 1e-6) {
          throw fail("Each payment must be an amount above 0 with at most 2 decimals.");
        }
        paidP += toPaise(amt);
        payments.push({ id: DB.uid(), method: pay.method, amount: toPaise(amt) / 100, at: at });
      }
      if (paidP > t.totalP) throw fail("Payments are more than the bill total.");
      const outstandingP = t.totalP - paidP;

      // When a sale creates credit, a customer MUST be registered.
      if (outstandingP > 0) {
        if (!customerId) {
          throw fail("Please select or add a registered customer when part or all of the bill is on credit (udhaar).");
        }
      }

      // 6. Next invoice number (same transaction, so numbers never repeat).
      const counters = tx.objectStore("counters");
      const counter = (await DB.req(counters.get("invoice"))) || { name: "invoice", value: 0 };
      counter.value += 1;
      counters.put(counter);
      const invoiceNo = prefix + "-" + String(counter.value).padStart(6, "0");

      // 7. Reduce stock exactly once and write the history.
      for (const c of checked) {
        const before = c.p.stock;
        const after = U.round(before - c.qty, 3);
        c.p.stock = after;
        c.p.updatedAt = at;
        prodStore.put(c.p);
        tx.objectStore("stockHistory").add(stockEntry(c.p, before, after, "sale", "Sale " + invoiceNo, at));
      }

      // 8. If credit sale, add customer ledger entry
      if (outstandingP > 0 && customerId) {
        const ledgerEntry = {
          id: DB.uid(),
          customerId: customerId,
          type: "credit_sale",
          saleId: input.id,
          invoiceNo: invoiceNo,
          repaymentId: null,
          debit: outstandingP / 100,
          credit: 0,
          amount: outstandingP / 100,
          paymentMethod: null,
          createdAt: at,
          note: "Credit sale " + invoiceNo,
          referenceId: null
        };
        ledgerStore.add(ledgerEntry);

        if (attachedCust) {
          attachedCust.updatedAt = at;
          custStore.put(attachedCust);
        }
      }

      // 9. Save the sale itself.
      const discountValue = input.discount && input.discount.value > 0 ? input.discount.value : 0;
      const finalCustomerName = attachedCust ? attachedCust.name : (customerName || "");
      const finalCustomerPhone = attachedCust ? (attachedCust.phone || "") : (customerPhone || "");

      const sale = {
        id: input.id, invoiceNo: invoiceNo, createdAt: at, dateKey: U.dateKey(at), status: "completed",
        items: lines,
        subtotal: t.subtotal,
        discount: t.discount, discountType: discountValue ? input.discount.type : "amount", discountValue: discountValue,
        taxRate: taxRate, tax: t.tax, total: t.total, cogs: t.cogs,
        payments: payments, amountPaid: paidP / 100, outstanding: outstandingP / 100,
        customerId: customerId,
        customerName: finalCustomerName, customerPhone: finalCustomerPhone,
        cancellation: null,
        events: [{ type: "created", at: at }]
      };
      salesStore.add(sale);
      return sale;
    });
  }

  /*
   * cancel(saleId, reason)
   * Marks a completed sale as cancelled, returns its stock, reverses active credit in the
   * customer ledger exactly once, and logs the event.
   * Status check and reversals happen inside ONE transaction.
   */
  function cancel(saleId, reason) {
    reason = String(reason || "").trim();
    if (reason.length < 3) return Promise.reject(fail("Enter a reason (at least 3 characters)."));

    return DB.run(["products", "stockHistory", "sales", "customerLedger", "repaymentAllocations"], "readwrite", async (tx) => {
      const salesStore = tx.objectStore("sales");
      const sale = await DB.req(salesStore.get(saleId));
      if (!sale) throw fail("Sale not found.");
      if (sale.status !== "completed") throw fail("This sale is already cancelled. Stock was not changed again.", "ALREADY_CANCELLED");

      const at = DB.now();
      const prodStore = tx.objectStore("products");

      // 1. Put back stock
      for (const it of sale.items) {
        const p = await DB.req(prodStore.get(it.productId));
        if (!p) throw fail("A product from this sale no longer exists, so stock cannot be returned.");
        const before = p.stock;
        const after = U.round(before + it.qty, 3);
        p.stock = after;
        p.updatedAt = at;
        prodStore.put(p);
        tx.objectStore("stockHistory").add(stockEntry(p, before, after, "sale-cancel", "Sale cancelled: " + sale.invoiceNo, at));
      }

      // 2. Customer credit and repayment reversals
      let totalRepaidP = 0;
      const allocStore = tx.objectStore("repaymentAllocations");
      let allocations = [];
      try {
        const saleIndex = allocStore.index("saleId");
        allocations = await DB.req(saleIndex.getAll(sale.id));
      } catch (_) {
        allocations = [];
      }

      for (const alloc of allocations) {
        if (alloc.status !== "reversed") {
          totalRepaidP += Math.round(alloc.amount * 100);
          alloc.status = "reversed";
          alloc.reversedAt = at;
          allocStore.put(alloc);
        }
      }

      const initialOutstandingP = Math.round((sale.outstanding || 0) * 100);
      const remainingUnpaidP = Math.max(0, initialOutstandingP - totalRepaidP);

      // If there was remaining unpaid credit on this bill, reverse it in the customer ledger
      if (sale.customerId && remainingUnpaidP > 0) {
        const ledgerStore = tx.objectStore("customerLedger");
        const revEntry = {
          id: DB.uid(),
          customerId: sale.customerId,
          type: "cancellation",
          saleId: sale.id,
          invoiceNo: sale.invoiceNo,
          repaymentId: null,
          debit: 0,
          credit: remainingUnpaidP / 100,
          amount: remainingUnpaidP / 100,
          paymentMethod: null,
          createdAt: at,
          note: "Credit reversed for cancelled sale " + sale.invoiceNo,
          referenceId: sale.id
        };
        ledgerStore.add(revEntry);
      }

      // Total money collected that shopkeeper must refund
      const totalCollected = (Math.round((sale.amountPaid || 0) * 100) + totalRepaidP) / 100;

      sale.status = "cancelled";
      sale.cancellation = {
        at: at,
        reason: reason,
        refundDue: totalCollected,
        salePaidRefund: sale.amountPaid || 0,
        repaymentsRefund: totalRepaidP / 100
      };
      sale.events.push({ type: "cancelled", at: at, reason: reason });
      salesStore.put(sale);

      return sale;
    });
  }

  /* ---------- reading + cache ---------- */

  let cache = [];
  let status = "loading"; // loading | ready | failed
  let lastError = "";

  function loadAll() {
    return DB.run(["sales"], "readonly", (tx) => DB.req(tx.objectStore("sales").getAll()))
      .then((rows) => rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }

  async function refresh() {
    try {
      cache = await loadAll();
      status = "ready";
      lastError = "";
    } catch (e) {
      status = "failed";
      lastError = e.message;
    }
    document.dispatchEvent(new CustomEvent("sales-changed"));
  }

  // Dashboard numbers for TODAY (Indian date), from completed sales only.
  function dashboard() {
    const today = U.todayKey();
    const t = { sales: 0, cash: 0, upi: 0, other: 0, credit: 0, gross: 0, costMissing: false, count: 0 };
    cache.forEach((s) => {
      if (s.status !== "completed") return;
      if (s.dateKey !== today) return;
      t.count += 1;
      t.sales += s.total;
      t.credit += s.outstanding;
      t.gross += s.subtotal - s.discount - s.cogs; // net sales (no tax) minus cost of goods
      if (s.items.some((i) => i.costMissing)) t.costMissing = true;
      s.payments.forEach((p) => {
        if (p.method === "cash") t.cash += p.amount;
        else if (p.method === "upi") t.upi += p.amount;
        else t.other += p.amount;
      });
    });
    ["sales", "cash", "upi", "other", "credit", "gross"].forEach((k) => { t[k] = U.round(t[k], 2); });

    // Customer credit due is derived live from customer ledger / active credit
    let creditOutstanding = 0;
    if (window.DukaanCustomers && typeof window.DukaanCustomers.totalCreditOutstanding === "function") {
      creditOutstanding = window.DukaanCustomers.totalCreditOutstanding();
    } else {
      // Fallback if customers module not ready yet: completed sales outstanding
      cache.forEach((s) => {
        if (s.status === "completed") creditOutstanding += (s.outstanding || 0);
      });
      creditOutstanding = U.round(creditOutstanding, 2);
    }

    return { today: t, creditOutstanding: creditOutstanding, recent: cache.slice(0, 6) };
  }

  function customerNames() {
    return Array.from(new Set(cache.map((s) => s.customerName).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }

  document.addEventListener("DOMContentLoaded", refresh);

  window.DukaanSales = {
    calc: calc,
    complete: complete,
    cancel: cancel,
    refresh: refresh,
    cached: () => cache.slice(),
    getCached: (id) => cache.find((s) => s.id === id) || null,
    status: () => status,
    error: () => lastError,
    dashboard: dashboard,
    customerNames: customerNames
  };
})();