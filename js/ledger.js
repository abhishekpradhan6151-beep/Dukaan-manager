/*
 * ledger.js - Phase 4: customers, the udhaar ledger and repayments (data and rules, no screens).
 *
 * THE LEDGER IS THE SOURCE OF TRUTH. A customer's balance is never stored or edited; it is the
 * sum of their ledger entries. Sign convention (amounts are rupees, calculated in paise):
 *     amount > 0   DEBIT   the customer owes more
 *     amount < 0   CREDIT  the customer owes less
 *
 * Entry types
 *     opening      +   opening balance entered when the customer was added
 *     credit-sale  +   the UNPAID part of a sale (a fully paid sale writes nothing)
 *     repayment    -   money received against one bill (or against the opening balance)
 *     sale-cancel  -   cancelling a sale removes whatever was still unpaid on it
 *
 * Every entry has a refKey ("sale:<saleId>" or "opening:<customerId>"). What is still owed on a
 * bill is the sum of the entries that share its refKey. Entries are never edited or deleted; a
 * correction is a new entry that points at the one it reverses (reversesEntryId).
 *
 * Every financial change is ONE database transaction. Fixed entry ids ("led:sale:<saleId>",
 * "led:cancel:<saleId>", "led:rep:<repaymentId>:<n>") mean the same event can never be written twice,
 * and a repayment carries the id of the form that created it, so a repeated click or resend is refused.
 * A repayment writes only to customers/ledger/repayments/counters. It never touches products,
 * stock or the sale records, so it cannot change inventory or sales revenue.
 */
(function () {
  "use strict";

  const DB = window.DukaanDB;
  const U = window.DukaanUtil;

  const toP = (rupees) => Math.round(rupees * 100);
  const saleKey = (saleId) => "sale:" + saleId;
  const openKey = (customerId) => "opening:" + customerId;
  const phoneKey = (s) => String(s || "").replace(/\D/g, "");

  function fail(message, code, extra) {
    const e = new Error(message);
    if (code) e.code = code;
    if (extra) Object.assign(e, extra);
    return e;
  }

  /* =====================  VALIDATION  ===================== */

  // Raw form values in, { errs: {fieldId: message}, vals } out. Field ids match the form.
  function validateCustomer(v, isNew) {
    const errs = {};
    if (!v.name) errs.fcName = "Enter the customer’s name.";
    else if (v.name.length > 80) errs.fcName = "Name is too long (max 80 characters).";
    if (v.phone) {
      const digits = phoneKey(v.phone);
      if (!/^[0-9+\-() ]+$/.test(v.phone) || digits.length < 5 || digits.length > 15) {
        errs.fcPhone = "Enter a valid phone number (5 to 15 digits), or leave it empty.";
      }
    }
    if (v.address.length > 200) errs.fcAddress = "Address is too long (max 200 characters).";
    if (v.notes.length > 500) errs.fcNotes = "Notes are too long (max 500 characters).";
    let opening = 0;
    if (isNew && v.opening !== "") {
      opening = U.parseMoney(v.opening);
      if (Number.isNaN(opening)) { errs.fcOpening = "Enter an amount such as 500 or 250.50, or leave it empty."; opening = 0; }
    }
    return { errs: errs, vals: { openingP: toP(opening) } };
  }

  /* =====================  TRANSACTION HELPERS  ===================== */

  // Next ledger sequence number (gives every entry a fixed place in the order, even within one second).
  async function nextSeq(tx) {
    const store = tx.objectStore("counters");
    const c = (await DB.req(store.get("ledger"))) || { name: "ledger", value: 0 };
    c.value += 1;
    store.put(c);
    return c.value;
  }

  function makeEntry(o) {
    return {
      id: o.id, seq: o.seq, customerId: o.customerId, type: o.type, refKey: o.refKey,
      saleId: o.saleId || null, invoiceNo: o.invoiceNo || "",
      amount: o.amountP / 100, method: o.method || "", repaymentId: o.repaymentId || null,
      reversesEntryId: o.reversesEntryId || null, notes: o.notes || "",
      createdAt: o.createdAt, dateKey: U.dateKey(o.createdAt)
    };
  }

  // Called by sales.complete() INSIDE its transaction, for the unpaid part of a sale.
  async function addCreditSaleEntry(tx, sale, outstandingP, createdAt, notes) {
    const seq = await nextSeq(tx);
    const entry = makeEntry({
      id: "led:sale:" + sale.id, seq: seq, customerId: sale.customerId, type: "credit-sale",
      refKey: saleKey(sale.id), saleId: sale.id, invoiceNo: sale.invoiceNo, amountP: outstandingP,
      notes: notes, createdAt: createdAt
    });
    tx.objectStore("ledger").add(entry); // fixed id: one sale can never get two credit entries
    return entry;
  }

  // Called by sales.cancel() INSIDE its transaction. Removes what is still unpaid on the sale.
  // Returns how much credit was reversed and how much the customer had already repaid on it.
  async function reverseSaleCredit(tx, sale, reason, at) {
    if (!sale.customerId) return { reversedP: 0, repaidP: 0 };
    const led = tx.objectStore("ledger");
    const rows = await DB.req(led.index("refKey").getAll(saleKey(sale.id)));
    let sumP = 0, repaidP = 0, creditEntry = null;
    rows.forEach((r) => {
      const p = toP(r.amount);
      sumP += p;
      if (r.type === "repayment") repaidP += -p;
      if (r.type === "credit-sale") creditEntry = r;
    });
    if (!creditEntry) return { reversedP: 0, repaidP: 0 };
    if (sumP > 0) {
      const seq = await nextSeq(tx);
      led.add(makeEntry({
        id: "led:cancel:" + sale.id, seq: seq, customerId: sale.customerId, type: "sale-cancel",
        refKey: saleKey(sale.id), saleId: sale.id, invoiceNo: sale.invoiceNo, amountP: -sumP,
        reversesEntryId: creditEntry.id, notes: reason, createdAt: at
      }));
    }
    return { reversedP: Math.max(0, sumP), repaidP: repaidP };
  }

  // Group entries into "items" (bills and the opening balance) with what is still owed on each.
  function itemsFromEntries(rows) {
    const map = new Map();
    rows.forEach((r) => {
      let it = map.get(r.refKey);
      if (!it) {
        it = {
          refKey: r.refKey, kind: r.refKey.indexOf("opening:") === 0 ? "opening" : "sale",
          saleId: r.saleId, invoiceNo: r.invoiceNo, createdAt: r.createdAt, seq: r.seq,
          creditP: 0, repaidP: 0, cancelledP: 0, outP: 0
        };
        map.set(r.refKey, it);
      }
      const p = toP(r.amount);
      it.outP += p;
      if (r.type === "repayment") it.repaidP += -p;
      else if (r.type === "sale-cancel") it.cancelledP += -p;
      else it.creditP += p;
    });
    return Array.from(map.values()).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.seq - b.seq));
  }

  /* =====================  CUSTOMERS  ===================== */

  // The form's id makes this safe to repeat: the same id returns the customer already saved.
  function createCustomer(input) {
    return DB.run(["customers", "ledger", "counters"], "readwrite", async (tx) => {
      const store = tx.objectStore("customers");
      const existing = await DB.req(store.get(input.id));
      if (existing) return existing;
      const at = DB.now();
      const name = String(input.name || "").trim();
      const phone = String(input.phone || "").trim();
      if (!name) throw fail("Enter the customer’s name.");
      const c = {
        id: input.id, name: name, nameKey: name.toLowerCase(), phone: phone, phoneKey: phoneKey(phone),
        address: String(input.address || "").trim(), notes: String(input.notes || "").trim(),
        status: "active", createdAt: at, updatedAt: at
      };
      store.add(c);
      if (input.openingP > 0) {
        const seq = await nextSeq(tx);
        tx.objectStore("ledger").add(makeEntry({
          id: "led:open:" + c.id, seq: seq, customerId: c.id, type: "opening", refKey: openKey(c.id),
          amountP: input.openingP, notes: "Opening balance entered when the customer was added", createdAt: at
        }));
      }
      return c;
    });
  }

  // Only contact details can change. Balances come from the ledger and cannot be edited here.
  function updateCustomer(id, f) {
    return DB.run(["customers"], "readwrite", async (tx) => {
      const store = tx.objectStore("customers");
      const c = await DB.req(store.get(id));
      if (!c) throw fail("Customer not found.");
      c.name = String(f.name).trim(); c.nameKey = c.name.toLowerCase();
      c.phone = String(f.phone || "").trim(); c.phoneKey = phoneKey(c.phone);
      c.address = String(f.address || "").trim(); c.notes = String(f.notes || "").trim();
      c.updatedAt = DB.now();
      store.put(c);
      return c;
    });
  }

  function setCustomerStatus(id, status) {
    return DB.run(["customers"], "readwrite", async (tx) => {
      const store = tx.objectStore("customers");
      const c = await DB.req(store.get(id));
      if (!c) throw fail("Customer not found.");
      c.status = status;
      c.updatedAt = DB.now();
      store.put(c);
    });
  }

  /* =====================  REPAYMENTS  ===================== */

  /*
   * recordRepayment(input)
   *   id           id made when the repayment form was opened (same id = same repayment)
   *   customerId, method (cash/upi/card/bank), amount (rupees), reference, note
   *   allocations  [{ refKey, amount }] to choose the bills yourself, or null/omitted to pay the
   *                oldest bills first (worked out inside the transaction from fresh data)
   * One transaction: checks the id was not used, re-reads what is owed from the ledger, checks every
   * allocation, writes the repayment and its ledger entries together. Resolves after commit.
   */
  function recordRepayment(input) {
    return DB.run(["customers", "sales", "ledger", "repayments", "counters"], "readwrite", async (tx) => {
      const reps = tx.objectStore("repayments");
      const dup = await DB.req(reps.get(input.id));
      if (dup) throw fail("This repayment was already saved as " + dup.refNo + ". It was not saved a second time.", "DUPLICATE", { repayment: dup });

      if (!U.METHODS[input.method]) throw fail("Choose how the money was received.");
      const amountNum = Number(input.amount);
      const amountP = toP(amountNum);
      if (!(amountNum > 0) || Math.abs(amountNum * 100 - amountP) > 1e-6) throw fail("The amount must be above 0, with at most 2 decimals.");
      const reference = String(input.reference || "").trim().slice(0, 60);
      const note = String(input.note || "").trim().slice(0, 200);

      const customer = await DB.req(tx.objectStore("customers").get(input.customerId));
      if (!customer) throw fail("Customer not found.");

      // What is owed right now, from the ledger (not from the screen).
      const rows = await DB.req(tx.objectStore("ledger").index("customerId").getAll(input.customerId));
      const balanceP = rows.reduce((a, r) => a + toP(r.amount), 0);
      const salesStore = tx.objectStore("sales");
      const items = [];
      for (const it of itemsFromEntries(rows)) {
        if (it.outP <= 0) continue;
        if (it.kind === "sale") {
          const s = await DB.req(salesStore.get(it.saleId));
          if (!s || s.status !== "completed") continue; // a cancelled sale is never payable
        }
        items.push(it);
      }
      const totalOutP = items.reduce((a, it) => a + it.outP, 0);
      if (totalOutP <= 0) throw fail("This customer has nothing outstanding.", "NOTHING_DUE");
      if (amountP > totalOutP) {
        throw fail("This customer owes only " + U.money2(totalOutP / 100) + ". A repayment cannot be more than what is outstanding.", "OVERPAYMENT");
      }

      // Decide which bills the money goes to.
      let alloc = [];
      if (input.allocations && input.allocations.length) {
        const seen = new Set();
        let sumP = 0;
        for (const a of input.allocations) {
          const it = items.find((x) => x.refKey === a.refKey);
          if (!it) throw fail("One of the selected bills is no longer outstanding. Please review the repayment.", "ALLOCATION");
          if (seen.has(a.refKey)) throw fail("The same bill was selected twice.", "ALLOCATION");
          seen.add(a.refKey);
          const n = Number(a.amount);
          const p = toP(n);
          if (!(n > 0) || Math.abs(n * 100 - p) > 1e-6) throw fail("Each amount applied to a bill must be above 0, with at most 2 decimals.", "ALLOCATION");
          const label = it.kind === "opening" ? "the opening balance" : it.invoiceNo;
          if (p > it.outP) throw fail("Only " + U.money2(it.outP / 100) + " is outstanding on " + label + ".", "ALLOCATION");
          sumP += p;
          alloc.push({ it: it, p: p });
        }
        if (sumP !== amountP) throw fail("The amounts applied to bills (" + U.money2(sumP / 100) + ") must add up to the repayment (" + U.money2(amountP / 100) + ").", "ALLOCATION");
      } else {
        let left = amountP;
        for (const it of items) { // oldest first
          if (left <= 0) break;
          const p = Math.min(left, it.outP);
          alloc.push({ it: it, p: p });
          left -= p;
        }
      }

      // Write everything together.
      const at = DB.now();
      const refStore = tx.objectStore("counters");
      const counter = (await DB.req(refStore.get("repayment"))) || { name: "repayment", value: 0 };
      counter.value += 1;
      refStore.put(counter);
      const refNo = "REP-" + String(counter.value).padStart(6, "0");

      const led = tx.objectStore("ledger");
      const allocations = [];
      let n = 0;
      for (const a of alloc) {
        const seq = await nextSeq(tx);
        led.add(makeEntry({
          id: "led:rep:" + input.id + ":" + n, seq: seq, customerId: customer.id, type: "repayment",
          refKey: a.it.refKey, saleId: a.it.saleId || null, invoiceNo: a.it.invoiceNo || "", amountP: -a.p,
          method: input.method, repaymentId: input.id, notes: [reference, note].filter(Boolean).join(" · "), createdAt: at
        }));
        allocations.push({ refKey: a.it.refKey, kind: a.it.kind, saleId: a.it.saleId || null, invoiceNo: a.it.invoiceNo || "", amount: a.p / 100 });
        n += 1;
      }
      const rep = {
        id: input.id, refNo: refNo, customerId: customer.id, customerName: customer.name, customerPhone: customer.phone,
        method: input.method, amount: amountP / 100, reference: reference, note: note, allocations: allocations,
        createdAt: at, dateKey: U.dateKey(at), balanceBefore: balanceP / 100, balanceAfter: (balanceP - amountP) / 100,
        status: "recorded"
      };
      reps.add(rep);
      return rep;
    });
  }

  /* =====================  LINKING EARLIER (PHASE 3) CREDIT SALES  ===================== */

  /*
   * Sales made before Phase 4 stored only a customer NAME. This links them to customer records by
   * writing the ledger entry they never had. plan: [{ saleIds, customerId | null, newName, newPhone }]
   * (customerId null = create a new customer). Amounts are not changed; each sale gets an event.
   */
  function linkLegacy(plan) {
    return DB.run(["customers", "sales", "ledger", "counters"], "readwrite", async (tx) => {
      const custStore = tx.objectStore("customers");
      const salesStore = tx.objectStore("sales");
      const at = DB.now();
      let linked = 0, created = 0;
      for (const g of plan) {
        let cust;
        if (g.customerId) {
          cust = await DB.req(custStore.get(g.customerId));
          if (!cust) throw fail("A chosen customer no longer exists.");
        } else {
          const name = String(g.newName || "").trim() || "Unnamed customer";
          const phone = String(g.newPhone || "").trim();
          cust = {
            id: DB.uid(), name: name, nameKey: name.toLowerCase(), phone: phone, phoneKey: phoneKey(phone),
            address: "", notes: "Added when earlier credit sales were linked", status: "active", createdAt: at, updatedAt: at
          };
          custStore.add(cust);
          created += 1;
        }
        for (const saleId of g.saleIds) {
          const s = await DB.req(salesStore.get(saleId));
          if (!s || s.status !== "completed" || s.customerId || !(s.outstanding > 0)) continue; // already linked, cancelled or paid
          s.customerId = cust.id;
          s.events = (s.events || []).concat([{ type: "linked-customer", at: at, customerId: cust.id }]);
          salesStore.put(s);
          await addCreditSaleEntry(tx, s, toP(s.outstanding), s.createdAt, "Linked from a sale made before customer ledgers existed");
          linked += 1;
        }
      }
      return { linked: linked, created: created };
    });
  }

  /* =====================  READING + CACHE  ===================== */

  let cache = { customers: [], entries: [], repayments: [] };
  let byCustomer = new Map(); // customerId -> entries (oldest first)
  let byRef = new Map();      // refKey -> entries
  let status = "loading";     // loading | ready | failed
  let lastError = "";

  function loadAll() {
    return DB.run(["customers", "ledger", "repayments"], "readonly", async (tx) => {
      const res = await Promise.all([
        DB.req(tx.objectStore("customers").getAll()),
        DB.req(tx.objectStore("ledger").getAll()),
        DB.req(tx.objectStore("repayments").getAll())
      ]);
      return { customers: res[0], entries: res[1], repayments: res[2] };
    });
  }

  function index(data) {
    data.entries.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.seq - b.seq));
    data.repayments.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    cache = data;
    byCustomer = new Map();
    byRef = new Map();
    data.entries.forEach((e) => {
      if (!byCustomer.has(e.customerId)) byCustomer.set(e.customerId, []);
      byCustomer.get(e.customerId).push(e);
      if (!byRef.has(e.refKey)) byRef.set(e.refKey, []);
      byRef.get(e.refKey).push(e);
    });
  }

  // Reload without announcing it (sales.refresh() uses this, then announces once).
  async function reload() {
    try {
      index(await loadAll());
      status = "ready";
      lastError = "";
    } catch (e) {
      status = "failed";
      lastError = e.message;
      throw e;
    }
  }

  async function refresh() {
    try { await reload(); } catch (_) { /* status and error are kept for the screens */ }
    document.dispatchEvent(new CustomEvent("ledger-changed"));
  }

  const sumP = (rows) => rows.reduce((a, r) => a + toP(r.amount), 0);
  const entriesFor = (customerId) => (byCustomer.get(customerId) || []).slice();
  const balanceP = (customerId) => sumP(byCustomer.get(customerId) || []);
  const balance = (customerId) => balanceP(customerId) / 100;
  const getCustomer = (id) => cache.customers.find((c) => c.id === id) || null;

  // Bills (and the opening balance) the customer still owes on, oldest first.
  function itemsFor(customerId) {
    return itemsFromEntries(byCustomer.get(customerId) || []).filter((it) => it.outP > 0);
  }

  // Everything the customers owe, from the ledger. Cancelled bills were reversed, so they are not in it.
  function totalOutstanding() { return sumP(cache.entries) / 100; }

  function owingCount() {
    let n = 0;
    byCustomer.forEach((rows) => { if (sumP(rows) > 0) n += 1; });
    return n;
  }

  // Oldest first, each row carrying the running balance after it.
  function ledgerRows(customerId) {
    let run = 0;
    return (byCustomer.get(customerId) || []).map((e) => {
      run += toP(e.amount);
      return Object.assign({}, e, { balanceAfter: run / 100 });
    });
  }

  function summary(customerId) {
    const rows = byCustomer.get(customerId) || [];
    const items = itemsFromEntries(rows);
    let repaidP = 0;
    rows.forEach((e) => { if (e.type === "repayment") repaidP += -toP(e.amount); });
    return { balance: sumP(rows) / 100, owingBills: items.filter((i) => i.outP > 0).length, repaid: repaidP / 100 };
  }

  // What is still owed on one sale today. A sale not yet linked to a customer (made before
  // Phase 4) has no ledger, so its own unpaid amount is used.
  function dueForSale(sale) {
    if (!sale || sale.status !== "completed" || !(sale.outstanding > 0)) return 0;
    if (!sale.customerId) return sale.outstanding;
    return Math.max(0, sumP(byRef.get(saleKey(sale.id)) || [])) / 100;
  }

  function saleLedger(saleId) { return (byRef.get(saleKey(saleId)) || []).slice(); }

  function saleCredit(sale) {
    let repaidP = 0;
    saleLedger(sale.id).forEach((e) => { if (e.type === "repayment") repaidP += -toP(e.amount); });
    return { creditAtSale: sale.outstanding, repaid: repaidP / 100, dueNow: dueForSale(sale) };
  }

  const repaymentsFor = (customerId) => cache.repayments.filter((r) => r.customerId === customerId);
  const repaymentById = (id) => cache.repayments.find((r) => r.id === id) || null;
  function repaymentsToday() {
    const today = U.todayKey();
    return cache.repayments.reduce((a, r) => (r.dateKey === today ? a + toP(r.amount) : a), 0) / 100;
  }

  // Completed credit sales from before Phase 4 that are not linked to a customer yet.
  function unlinked() {
    const S = window.DukaanSales;
    if (!S) return [];
    return S.cached().filter((s) => s.status === "completed" && !s.customerId && s.outstanding > 0);
  }

  window.DukaanLedger = {
    // rules
    validateCustomer, createCustomer, updateCustomer, setCustomerStatus, recordRepayment, linkLegacy,
    // used by sales.js inside its own transactions
    addCreditSaleEntry, reverseSaleCredit,
    // reading
    reload, refresh, status: () => status, error: () => lastError,
    customers: () => cache.customers.slice(), getCustomer, entriesFor, balance, balanceP, itemsFor,
    totalOutstanding, owingCount, ledgerRows, summary, dueForSale, saleLedger, saleCredit,
    repayments: () => cache.repayments.slice(), repaymentsFor, repaymentById, repaymentsToday, unlinked,
    phoneKey
  };
})();
