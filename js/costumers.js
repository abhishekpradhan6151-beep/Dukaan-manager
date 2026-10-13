/*
 * customers.js - Phase 4: Customer Management & Udhaar Ledger.
 *
 * Provides:
 *   1. Customer CRUD (Add, Edit, Search, Archive/Restore)
 *   2. Derivation of balances from immutable, auditable ledger records
 *   3. Outstanding credit bills tracking and multi-bill repayment allocation
 *   4. Safe, atomic repayment recording inside ONE transaction with aggregate allocation validation
 *   5. Full ledger view with date & type filtering and running balances
 *   6. Repayment receipt printing & preview
 */
(function () {
  "use strict";

  const DB = window.DukaanDB;
  const U = window.DukaanUtil;
  const $ = U.$;
  const el = U.el;

  // In-memory cache for fast UI updates
  let customersCache = [];
  let ledgerCache = [];
  let repaymentsCache = [];
  let allocationsCache = [];
  let status = "loading"; // loading | ready | failed
  let lastError = "";

  let currentCustomerId = null;
  let ledgerFilter = { from: "", to: "", type: "" };
  let customerListSearch = "";
  let customerListFilter = "all"; // all | active | due | archived

  function fail(message, code, extra) {
    const e = new Error(message);
    if (code) e.code = code;
    if (extra) Object.assign(e, extra);
    return e;
  }

  /* ---------- Data Layer ---------- */

  async function loadAllData() {
    return DB.run(["customers", "customerLedger", "repayments", "repaymentAllocations"], "readonly", async (tx) => {
      const custs = await DB.req(tx.objectStore("customers").getAll());
      const ledger = await DB.req(tx.objectStore("customerLedger").getAll());
      const reps = await DB.req(tx.objectStore("repayments").getAll());
      const allocs = await DB.req(tx.objectStore("repaymentAllocations").getAll());
      return { custs, ledger, reps, allocs };
    });
  }

  async function refresh() {
    try {
      const d = await loadAllData();
      customersCache = (d.custs || []).sort((a, b) => a.name.localeCompare(b.name));
      ledgerCache = (d.ledger || []).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      repaymentsCache = (d.reps || []).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      allocationsCache = d.allocs || [];
      status = "ready";
      lastError = "";
    } catch (e) {
      status = "failed";
      lastError = e.message;
    }
    document.dispatchEvent(new CustomEvent("customers-changed"));
  }

  function getCustomer(id) {
    return customersCache.find((c) => c.id === id) || null;
  }

  function listCustomers() {
    return customersCache.slice();
  }

  function findCustomerByPhone(phone, excludeId) {
    const p = String(phone || "").trim();
    if (!p) return null;
    return customersCache.find((c) => c.phone && c.phone.trim() === p && c.id !== excludeId) || null;
  }

  // Calculate ledger with running balances for a customer
  function getCustomerLedger(customerId) {
    const entries = ledgerCache.filter((e) => e.customerId === customerId);
    entries.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

    let balanceP = 0;
    return entries.map((entry) => {
      const debitP = Math.round((entry.debit || 0) * 100);
      const creditP = Math.round((entry.credit || 0) * 100);
      balanceP += debitP - creditP;
      return Object.assign({}, entry, {
        runningBalance: balanceP / 100,
        runningBalanceP: balanceP
      });
    });
  }

  // Total outstanding balance calculated purely from ledger entries
  function getCustomerBalance(customerId) {
    const entries = ledgerCache.filter((e) => e.customerId === customerId);
    let balP = 0;
    entries.forEach((e) => {
      balP += Math.round((e.debit || 0) * 100) - Math.round((e.credit || 0) * 100);
    });
    return U.round(balP / 100, 2);
  }

  // Sum of outstanding balances across all customers (including archived customers)
  function totalCreditOutstanding() {
    const allCustIds = new Set(customersCache.map((c) => c.id));
    let totalP = 0;
    ledgerCache.forEach((e) => {
      if (allCustIds.has(e.customerId)) {
        totalP += Math.round((e.debit || 0) * 100) - Math.round((e.credit || 0) * 100);
      }
    });
    return Math.max(0, U.round(totalP / 100, 2));
  }

  // Get outstanding completed sales for a customer eligible for repayment
  function getCustomerOutstandingBills(customerId) {
    const sales = window.DukaanSales ? window.DukaanSales.cached() : [];
    const customerSales = sales.filter((s) => s.customerId === customerId && s.status === "completed" && (s.outstanding || 0) > 0);

    const bills = [];
    customerSales.forEach((sale) => {
      const saleInitialCreditP = Math.round(sale.outstanding * 100);
      const activeAllocs = allocationsCache.filter((a) => a.saleId === sale.id && a.status !== "reversed");
      let allocatedP = 0;
      activeAllocs.forEach((a) => { allocatedP += Math.round(a.amount * 100); });
      const remainingDueP = Math.max(0, saleInitialCreditP - allocatedP);
      if (remainingDueP > 0) {
        bills.push({
          saleId: sale.id,
          invoiceNo: sale.invoiceNo,
          createdAt: sale.createdAt,
          total: sale.total,
          originalCredit: sale.outstanding,
          alreadyRepaid: allocatedP / 100,
          remainingDue: remainingDueP / 100,
          remainingDueP: remainingDueP
        });
      }
    });

    // Oldest bills first
    return bills.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  // Auto-allocate repayment across outstanding bills (oldest first)
  function autoAllocate(bills, amount) {
    let unallocatedP = Math.round(amount * 100);
    const result = [];

    for (const b of bills) {
      if (unallocatedP <= 0) {
        result.push({ saleId: b.saleId, invoiceNo: b.invoiceNo, remainingDue: b.remainingDue, amount: 0 });
        continue;
      }
      const canTakeP = Math.min(unallocatedP, b.remainingDueP);
      result.push({
        saleId: b.saleId,
        invoiceNo: b.invoiceNo,
        remainingDue: b.remainingDue,
        amount: canTakeP / 100
      });
      unallocatedP -= canTakeP;
    }

    return { allocations: result, unallocated: unallocatedP / 100 };
  }

  /* ---------- Customer CRUD Operations ---------- */

  async function saveCustomer(input) {
    const name = String(input.name || "").trim().slice(0, 80);
    const phone = String(input.phone || "").trim().slice(0, 20);
    const address = String(input.address || "").trim().slice(0, 200);
    const notes = String(input.notes || "").trim().slice(0, 500);

    if (name.length < 2) throw fail("Customer name must be at least 2 characters.");

    const isEdit = Boolean(input.id);
    const at = DB.now();

    return DB.run(["customers"], "readwrite", async (tx) => {
      const store = tx.objectStore("customers");
      let customer;
      if (isEdit) {
        customer = await DB.req(store.get(input.id));
        if (!customer) throw fail("Customer not found.");
        customer.name = name;
        customer.phone = phone;
        customer.address = address;
        customer.notes = notes;
        customer.updatedAt = at;
        store.put(customer);
      } else {
        customer = {
          id: DB.uid(),
          name: name,
          phone: phone,
          address: address,
          notes: notes,
          createdAt: at,
          updatedAt: at,
          status: "active"
        };
        store.add(customer);
      }
      return customer;
    });
  }

  async function toggleArchive(customerId, archive) {
    return DB.run(["customers"], "readwrite", async (tx) => {
      const store = tx.objectStore("customers");
      const c = await DB.req(store.get(customerId));
      if (!c) throw fail("Customer not found.");
      c.status = archive ? "archived" : "active";
      c.updatedAt = DB.now();
      store.put(c);
      return c;
    });
  }

  /* ---------- Repayment Recording (Atomic & Idempotent) ---------- */

  async function recordRepayment(input) {
    const customerId = input.customerId;
    const amount = Number(input.amount);
    const method = input.method;
    const note = String(input.note || "").trim().slice(0, 200);
    const customAllocations = input.allocations || [];

    if (!U.METHODS[method]) throw fail("Please choose a valid payment method.");
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
      throw fail("Enter a repayment amount above 0 with at most 2 decimals.");
    }
    const amountP = Math.round(amount * 100);

    return DB.run(["customers", "customerLedger", "repayments", "repaymentAllocations", "counters", "sales"], "readwrite", async (tx) => {
      const custStore = tx.objectStore("customers");
      const ledgerStore = tx.objectStore("customerLedger");
      const repStore = tx.objectStore("repayments");
      const allocStore = tx.objectStore("repaymentAllocations");
      const salesStore = tx.objectStore("sales");
      const counters = tx.objectStore("counters");

      const customer = await DB.req(custStore.get(customerId));
      if (!customer) throw fail("Customer not found.");

      // Calculate live balance from ledger records inside this transaction
      let currentBalP = 0;
      const ledgerIndex = ledgerStore.index("customerId");
      const existingLedger = await DB.req(ledgerIndex.getAll(customerId));
      existingLedger.forEach((e) => {
        currentBalP += Math.round((e.debit || 0) * 100) - Math.round((e.credit || 0) * 100);
      });

      if (amountP > currentBalP) {
        throw fail("Repayment amount (" + U.money2(amount) + ") exceeds the customer's total outstanding balance (" + U.money2(currentBalP / 100) + "). Advance payments are not supported.");
      }

      // Re-verify outstanding bills and allocations inside transaction
      const salesIndex = salesStore.index("customerId");
      const custSales = await DB.req(salesIndex.getAll(customerId));
      const completedCreditSales = custSales.filter((s) => s.status === "completed" && (s.outstanding || 0) > 0);

      // Map saleId to remaining due
      const billRemainingMap = new Map();
      for (const s of completedCreditSales) {
        const saleCreditP = Math.round(s.outstanding * 100);
        const allocIndex = allocStore.index("saleId");
        const sAllocs = await DB.req(allocIndex.getAll(s.id));
        let repaidP = 0;
        sAllocs.forEach((a) => {
          if (a.status !== "reversed") repaidP += Math.round(a.amount * 100);
        });
        const dueP = Math.max(0, saleCreditP - repaidP);
        if (dueP > 0) billRemainingMap.set(s.id, { sale: s, dueP: dueP });
      }

      if (!customAllocations || !customAllocations.length) {
        throw fail("Repayment must have at least one bill allocation.");
      }

      // Validate each allocation entry and aggregate by saleId to prevent duplicate over-allocations
      let totalAllocatedP = 0;
      const aggregatedBySale = new Map();

      for (const a of customAllocations) {
        if (!a || typeof a !== "object" || !a.saleId) {
          throw fail("Invalid allocation: missing sale ID.");
        }
        const aAmt = Number(a.amount);
        if (!Number.isFinite(aAmt) || aAmt < 0 || Math.abs(aAmt * 100 - Math.round(aAmt * 100)) > 1e-6) {
          throw fail("Allocation amount must be a positive number with at most 2 decimals.");
        }
        const aAmtP = Math.round(aAmt * 100);
        if (aAmtP === 0) continue; // skip zero allocations

        // Verify sale existence and ownership
        const sale = await DB.req(salesStore.get(a.saleId));
        if (!sale) throw fail("Sale " + a.saleId + " does not exist.");
        if (sale.customerId !== customerId) {
          throw fail("Bill " + (sale.invoiceNo || a.saleId) + " does not belong to this customer.");
        }
        if (sale.status !== "completed") {
          throw fail("Bill " + sale.invoiceNo + " is not an active completed sale.");
        }

        const billInfo = billRemainingMap.get(a.saleId);
        if (!billInfo || billInfo.dueP <= 0) {
          throw fail("Bill " + sale.invoiceNo + " has no remaining credit due.");
        }

        const cur = aggregatedBySale.get(a.saleId) || { sale: sale, dueP: billInfo.dueP, totalAllocP: 0 };
        cur.totalAllocP += aAmtP;

        // Check if aggregated allocations for this bill exceed its remaining due
        if (cur.totalAllocP > cur.dueP) {
          throw fail("Allocated amount (" + U.money2(cur.totalAllocP / 100) + ") exceeds remaining balance (" + U.money2(cur.dueP / 100) + ") for bill " + sale.invoiceNo + ".");
        }

        aggregatedBySale.set(a.saleId, cur);
        totalAllocatedP += aAmtP;
      }

      // Verify total allocations vs repayment amount exactly in paise
      if (totalAllocatedP > amountP) {
        throw fail("Total bill allocations (" + U.money2(totalAllocatedP / 100) + ") exceed the repayment amount (" + U.money2(amount) + ").");
      }
      if (totalAllocatedP < amountP) {
        throw fail("Total bill allocations (" + U.money2(totalAllocatedP / 100) + ") are less than the repayment amount (" + U.money2(amount) + ").");
      }

      const validAllocations = [];
      for (const [sId, info] of aggregatedBySale.entries()) {
        validAllocations.push({
          saleId: sId,
          invoiceNo: info.sale.invoiceNo,
          amount: info.totalAllocP / 100
        });
      }

      // All validations passed! Now generate counter, records, and commit
      const counter = (await DB.req(counters.get("repayment"))) || { name: "repayment", value: 0 };
      counter.value += 1;
      counters.put(counter);
      const receiptNo = "RCP-" + String(counter.value).padStart(6, "0");

      const at = DB.now();
      const repaymentId = DB.uid();

      // 1. Create Repayment record
      const repayment = {
        id: repaymentId,
        receiptNo: receiptNo,
        customerId: customerId,
        customerName: customer.name,
        amount: amount,
        method: method,
        note: note,
        createdAt: at,
        allocations: validAllocations
      };
      repStore.add(repayment);

      // 2. Create Repayment Allocation records
      for (const val of validAllocations) {
        allocStore.add({
          id: DB.uid(),
          repaymentId: repaymentId,
          saleId: val.saleId,
          invoiceNo: val.invoiceNo,
          customerId: customerId,
          amount: val.amount,
          createdAt: at,
          status: "active"
        });
      }

      // 3. Create Ledger entry (Credit to customer account)
      const billRefStr = validAllocations.map((a) => a.invoiceNo).join(", ");
      const ledgerEntry = {
        id: DB.uid(),
        customerId: customerId,
        type: "repayment",
        saleId: validAllocations.length === 1 ? validAllocations[0].saleId : null,
        invoiceNo: validAllocations.length === 1 ? validAllocations[0].invoiceNo : null,
        repaymentId: repaymentId,
        debit: 0,
        credit: amount,
        amount: amount,
        paymentMethod: method,
        createdAt: at,
        note: "Repayment " + receiptNo + (billRefStr ? " (for " + billRefStr + ")" : "") + (note ? " · " + note : ""),
        referenceId: repaymentId
      };
      ledgerStore.add(ledgerEntry);

      // 4. Update customer timestamp
      customer.updatedAt = at;
      custStore.put(customer);

      const remainingBalP = currentBalP - amountP;
      return {
        repayment: repayment,
        customer: customer,
        remainingBalance: remainingBalP / 100
      };
    });
  }

  /* ---------- UI Controller & Views ---------- */

  function renderCustomerStats() {
    const activeCount = customersCache.filter((c) => c.status === "active").length;
    const archivedCount = customersCache.filter((c) => c.status === "archived").length;
    let dueCount = 0;
    const totalDue = totalCreditOutstanding();

    customersCache.forEach((c) => {
      const b = getCustomerBalance(c.id);
      if (b > 0) {
        dueCount++;
      }
    });

    const wrap = $("custStatsCards");
    if (!wrap) return;
    wrap.replaceChildren(
      el("div", "card", ""),
      el("div", "card accent-gold", ""),
      el("div", "card accent-teal", "")
    );
    wrap.children[0].append(
      el("div", "card-label", "Active Customers"),
      el("div", "card-value", String(activeCount)),
      el("div", "card-hint", archivedCount > 0 ? archivedCount + " archived" : "In your contact book")
    );
    wrap.children[1].append(
      el("div", "card-label", "Total Credit Due"),
      el("div", "card-value", U.money(totalDue)),
      el("div", "card-hint", dueCount + " customers with balance (incl. archived)")
    );
    wrap.children[2].append(
      el("div", "card-label", "With Outstanding"),
      el("div", "card-value", String(dueCount)),
      el("div", "card-hint", "Pending Udhaar")
    );
  }

  function getFilteredCustomers() {
    const q = customerListSearch.trim().toLowerCase();
    return customersCache.filter((c) => {
      if (customerListFilter === "active" && c.status !== "active") return false;
      if (customerListFilter === "archived" && c.status !== "archived") return false;
      const bal = getCustomerBalance(c.id);
      if (customerListFilter === "due" && !(bal > 0)) return false;
      if (q) {
        const matchesName = c.name.toLowerCase().includes(q);
        const matchesPhone = (c.phone || "").toLowerCase().includes(q);
        if (!matchesName && !matchesPhone) return false;
      }
      return true;
    });
  }

  function renderCustomerList() {
    const wrap = $("custListWrap");
    if (!wrap) return;
    wrap.replaceChildren();

    renderCustomerStats();

    if (status === "failed") {
      wrap.append(el("p", "alert", lastError + " Customers are unavailable."));
      return;
    }
    if (status !== "ready") {
      wrap.append(el("p", "muted", "Loading customers…"));
      return;
    }

    if (!customersCache.length) {
      const e = el("div", "empty-state");
      e.append(
        el("h2", "", "No customers yet"),
        el("p", "", "Add customers to track credit sales, udhaar ledgers, and repayments.")
      );
      const b = el("button", "btn btn-primary", "+ Add your first customer");
      b.type = "button";
      b.style.marginTop = ".8rem";
      b.addEventListener("click", () => openCustomerDialog());
      e.append(b);
      wrap.append(e);
      return;
    }

    const list = getFilteredCustomers();
    $("custListCount").textContent = list.length + (list.length === 1 ? " customer" : " customers") + " shown (of " + customersCache.length + " total)";

    if (!list.length) {
      const e = el("div", "empty-state");
      e.append(el("h2", "", "No customers match"), el("p", "", "Try a different search term or filter."));
      wrap.append(e);
      return;
    }

    // Table view (tablet/desktop)
    const tw = el("div", "table-wrap");
    const table = el("table");
    table.append(el("caption", "sr-only", "Customer list"));
    const thead = el("thead"), hr = el("tr");
    ["Customer Name", "Phone", "Outstanding Udhaar", "Status", "Actions"].forEach((h, i) => {
      const th = el("th", i === 2 ? "num" : "", h);
      th.scope = "col";
      hr.append(th);
    });
    thead.append(hr);

    const tbody = el("tbody");
    const cards = el("div", "tx-list");

    list.forEach((c) => {
      const bal = getCustomerBalance(c.id);
      const isArchived = c.status === "archived";

      // Table row
      const tr = el("tr");
      const nameTd = el("td");
      nameTd.append(el("strong", "", c.name));

      const phoneTd = el("td", "", c.phone || "–");

      const balTd = el("td", "num");
      if (bal > 0) {
        balTd.append(el("span", "sum-due", U.money2(bal)));
      } else {
        balTd.textContent = "₹0.00";
      }

      const statusTd = el("td");
      statusTd.append(el("span", "badge" + (isArchived ? " muted" : (bal > 0 ? " credit" : "")), isArchived ? "Archived" : (bal > 0 ? "Credit Due" : "Clear")));

      const actTd = el("td");
      const actWrap = el("div", "p-actions");
      const viewBtn = el("button", "btn btn-sm", "Profile & Ledger");
      viewBtn.type = "button";
      viewBtn.addEventListener("click", () => showCustomerDetail(c.id));
      actWrap.append(viewBtn);

      if (bal > 0) {
        const payBtn = el("button", "btn btn-sm btn-primary", "Repay");
        payBtn.type = "button";
        payBtn.addEventListener("click", () => openRepaymentDialog(c.id));
        actWrap.append(payBtn);
      }
      actTd.append(actWrap);

      tr.append(nameTd, phoneTd, balTd, statusTd, actTd);
      tbody.append(tr);

      // Mobile Card
      const card = el("div", "p-card");
      const top = el("div", "p-card-top");
      const left = el("div");
      left.append(el("strong", "", c.name));
      if (c.phone) left.append(el("div", "card-hint", "📞 " + c.phone));
      const right = el("div");
      right.style.textAlign = "right";
      right.append(el("strong", bal > 0 ? "sum-due" : "", U.money2(bal)));
      const bw = el("div");
      bw.append(el("span", "badge" + (isArchived ? " muted" : (bal > 0 ? " credit" : "")), isArchived ? "Archived" : (bal > 0 ? "Due" : "Clear")));
      right.append(bw);
      top.append(left, right);

      const bot = el("div", "p-actions");
      bot.style.marginTop = ".6rem";
      const cardViewBtn = el("button", "btn btn-sm", "View Details");
      cardViewBtn.type = "button";
      cardViewBtn.addEventListener("click", () => showCustomerDetail(c.id));
      bot.append(cardViewBtn);

      if (bal > 0) {
        const cardPayBtn = el("button", "btn btn-sm btn-primary", "Record Repayment");
        cardPayBtn.type = "button";
        cardPayBtn.addEventListener("click", () => openRepaymentDialog(c.id));
        bot.append(cardPayBtn);
      }
      card.append(top, bot);
      cards.append(card);
    });

    table.append(thead, tbody);
    tw.append(table);
    wrap.append(tw, cards);
  }

  /* ---------- Customer Detail & Ledger View ---------- */

  function showCustomerDetail(customerId) {
    const c = getCustomer(customerId);
    if (!c) {
      U.toast("Customer not found.");
      return;
    }
    currentCustomerId = customerId;

    $("custListView").hidden = true;
    $("custDetailView").hidden = false;

    renderCustomerProfile(c);
  }

  function hideCustomerDetail() {
    currentCustomerId = null;
    $("custDetailView").hidden = true;
    $("custListView").hidden = false;
    renderCustomerList();
  }

  function renderCustomerProfile(customer) {
    $("cdName").textContent = customer.name;
    const phoneWrap = $("cdPhoneWrap");
    if (customer.phone) {
      $("cdPhone").textContent = customer.phone;
      phoneWrap.hidden = false;
    } else {
      phoneWrap.hidden = true;
    }

    const addrWrap = $("cdAddressWrap");
    if (customer.address) {
      $("cdAddress").textContent = customer.address;
      addrWrap.hidden = false;
    } else {
      addrWrap.hidden = true;
    }

    const notesWrap = $("cdNotesWrap");
    if (customer.notes) {
      $("cdNotes").textContent = customer.notes;
      notesWrap.hidden = false;
    } else {
      notesWrap.hidden = true;
    }

    const isArchived = customer.status === "archived";
    const badge = $("cdStatusBadge");
    badge.className = "badge" + (isArchived ? " muted" : "");
    badge.textContent = isArchived ? "Archived Customer" : "Active Customer";

    $("cdArchiveBtn").textContent = isArchived ? "Restore Customer" : "Archive Customer";

    const balance = getCustomerBalance(customer.id);
    $("cdBalance").textContent = U.money2(balance);
    $("cdBalance").className = "card-value" + (balance > 0 ? " sum-due" : "");

    const outstandingBills = getCustomerOutstandingBills(customer.id);
    $("cdBillsCount").textContent = String(outstandingBills.length);

    $("cdRepayBtn").disabled = balance <= 0;

    renderOutstandingBillsSection(outstandingBills);
    renderLedgerTable(customer.id);
  }

  function renderOutstandingBillsSection(bills) {
    const wrap = $("cdBillsWrap");
    wrap.replaceChildren();

    if (!bills.length) {
      wrap.append(el("p", "muted", "No outstanding bills for this customer. All invoices are fully paid."));
      return;
    }

    const tw = el("div", "table-wrap");
    const table = el("table");
    const thead = el("thead"), hr = el("tr");
    ["Invoice", "Date", "Bill Total", "Paid", "Due", "Action"].forEach((h, i) => {
      const th = el("th", i >= 2 && i <= 4 ? "num" : "", h);
      hr.append(th);
    });
    thead.append(hr);

    const tbody = el("tbody");
    bills.forEach((b) => {
      const tr = el("tr");
      const invTd = el("td");
      invTd.append(el("strong", "", b.invoiceNo));

      const dtTd = el("td", "", U.dateTime(b.createdAt));
      const totTd = el("td", "num", U.money2(b.total));
      const paidTd = el("td", "num", U.money2(b.alreadyRepaid + (b.total - b.originalCredit)));
      const dueTd = el("td", "num sum-due", U.money2(b.remainingDue));

      const actTd = el("td");
      const payThisBtn = el("button", "btn btn-sm btn-primary", "Pay this bill");
      payThisBtn.type = "button";
      payThisBtn.addEventListener("click", () => openRepaymentDialog(currentCustomerId, b.saleId));
      actTd.append(payThisBtn);

      tr.append(invTd, dtTd, totTd, paidTd, dueTd, actTd);
      tbody.append(tr);
    });

    table.append(thead, tbody);
    tw.append(table);
    wrap.append(tw);
  }

  function renderLedgerTable(customerId) {
    const wrap = $("cdLedgerWrap");
    wrap.replaceChildren();

    const fullLedger = getCustomerLedger(customerId);

    // Apply ledger filters
    const from = $("cdLFrom").value;
    const to = $("cdLTo").value;
    const type = $("cdLType").value;

    const filtered = fullLedger.filter((entry) => {
      const dKey = U.dateKey(entry.createdAt);
      if (from && dKey < from) return false;
      if (to && dKey > to) return false;
      if (type && entry.type !== type) return false;
      return true;
    });

    if (!fullLedger.length) {
      const e = el("div", "empty-state");
      e.append(el("h3", "", "No ledger entries yet"), el("p", "", "Transactions and credit sales will appear in this ledger."));
      wrap.append(e);
      return;
    }

    if (!filtered.length) {
      wrap.append(el("p", "muted", "No ledger entries match the selected date or type filters."));
      return;
    }

    const tw = el("div", "table-wrap");
    const table = el("table");
    const thead = el("thead"), hr = el("tr");
    ["Date & Time", "Reference", "Description", "Debit (+)", "Credit (−)", "Balance"].forEach((h, i) => {
      const th = el("th", i >= 3 ? "num" : "", h);
      hr.append(th);
    });
    thead.append(hr);

    const tbody = el("tbody");
    filtered.slice().reverse().forEach((entry) => {
      const tr = el("tr");

      const dtTd = el("td", "", U.dateTime(entry.createdAt));

      const refTd = el("td");
      if (entry.invoiceNo) {
        const link = el("button", "btn btn-sm", entry.invoiceNo);
        link.type = "button";
        link.addEventListener("click", () => {
          if (window.DukaanHistory && entry.saleId) window.DukaanHistory.showSale(entry.saleId);
        });
        refTd.append(link);
      } else if (entry.repaymentId) {
        const rep = repaymentsCache.find((r) => r.id === entry.repaymentId);
        refTd.textContent = rep ? rep.receiptNo : "Repayment";
      } else {
        refTd.textContent = "–";
      }

      const descTd = el("td", "", entry.note || entry.type);

      const debTd = el("td", "num");
      debTd.textContent = entry.debit > 0 ? U.money2(entry.debit) : "–";

      const credTd = el("td", "num");
      credTd.textContent = entry.credit > 0 ? U.money2(entry.credit) : "–";

      const balTd = el("td", "num");
      balTd.append(el("strong", entry.runningBalance > 0 ? "sum-due" : "", U.money2(entry.runningBalance)));

      tr.append(dtTd, refTd, descTd, debTd, credTd, balTd);
      tbody.append(tr);
    });

    table.append(thead, tbody);
    tw.append(table);
    wrap.append(tw);
  }

  /* ---------- Add / Edit Customer Dialog ---------- */

  let editCustomerId = null;
  let saveCustomerBusy = false;

  function openCustomerDialog(customerId, prefillData) {
    editCustomerId = customerId || null;
    const form = $("customerForm");
    form.reset();
    $("custError").hidden = true;
    $("custWarn").hidden = true;
    $("e-custName").textContent = "";
    $("e-custPhone").textContent = "";

    if (editCustomerId) {
      const c = getCustomer(editCustomerId);
      if (!c) return;
      $("custDlgTitle").textContent = "Edit Customer";
      $("custName").value = c.name;
      $("custPhone").value = c.phone || "";
      $("custAddress").value = c.address || "";
      $("custNotes").value = c.notes || "";
    } else {
      $("custDlgTitle").textContent = "Add Customer";
      if (prefillData) {
        if (prefillData.name) $("custName").value = prefillData.name;
        if (prefillData.phone) $("custPhone").value = prefillData.phone;
      }
    }

    $("customerDialog").showModal();
    $("custName").focus();
  }

  async function onCustomerFormSubmit(e) {
    e.preventDefault();
    if (saveCustomerBusy) return;

    const name = $("custName").value.trim();
    const phone = $("custPhone").value.trim();
    const address = $("custAddress").value.trim();
    const notes = $("custNotes").value.trim();

    $("e-custName").textContent = "";
    $("e-custPhone").textContent = "";
    $("custError").hidden = true;

    if (name.length < 2) {
      $("e-custName").textContent = "Customer name must be at least 2 characters.";
      $("custName").focus();
      return;
    }

    // Phone duplicate warning check
    if (phone) {
      const existing = findCustomerByPhone(phone, editCustomerId);
      if (existing && !e.target.dataset.warnBypassed) {
        const warnBox = $("custWarn");
        warnBox.replaceChildren();
        warnBox.append(
          el("strong", "", "Duplicate Phone Warning: "),
          el("span", "", "Another customer “" + existing.name + "” already has the phone number " + phone + ". Tap Save again to proceed anyway.")
        );
        warnBox.hidden = false;
        e.target.dataset.warnBypassed = "true";
        return;
      }
    }

    saveCustomerBusy = true;
    const saveBtn = $("custSaveBtn");
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";

    try {
      const saved = await saveCustomer({
        id: editCustomerId,
        name: name,
        phone: phone,
        address: address,
        notes: notes
      });

      $("customerDialog").close();
      delete e.target.dataset.warnBypassed;
      await refresh();
      U.toast(editCustomerId ? "Customer updated: " + saved.name : "Customer added: " + saved.name);

      if (currentCustomerId === saved.id) {
        renderCustomerProfile(saved);
      }

      document.dispatchEvent(new CustomEvent("customer-quick-added", { detail: { customer: saved } }));
    } catch (err) {
      $("custError").textContent = err.message;
      $("custError").hidden = false;
    } finally {
      saveCustomerBusy = false;
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Customer";
    }
  }

  /* ---------- Record Repayment Dialog & Confirmation ---------- */

  let repayCustomerId = null;
  let repayBusy = false;
  let repaymentPendingData = null;

  function openRepaymentDialog(customerId, specificSaleId) {
    const c = getCustomer(customerId);
    if (!c) {
      U.toast("Customer not found.");
      return;
    }
    repayCustomerId = customerId;
    repayBusy = false;
    repaymentPendingData = null;

    $("repayForm").reset();
    $("repayError").hidden = true;
    $("repayConfirmBox").hidden = true;
    $("repayInputSection").hidden = false;
    $("repaySubmitBtn").textContent = "Review Repayment";

    $("repayTitle").textContent = "Record Repayment – " + c.name;
    const bal = getCustomerBalance(c.id);
    $("repayCustomerBal").textContent = U.money2(bal);

    const bills = getCustomerOutstandingBills(c.id);
    renderRepaymentBillsTable(bills, specificSaleId);

    if (specificSaleId) {
      const targetBill = bills.find((b) => b.saleId === specificSaleId);
      if (targetBill) {
        $("repayAmount").value = targetBill.remainingDue.toFixed(2);
        updateBillAllocationsFromTotal(targetBill.remainingDue);
      }
    }

    $("repaymentDialog").showModal();
    $("repayAmount").focus();
  }

  function renderRepaymentBillsTable(bills, preselectedSaleId) {
    const tbody = $("repayBillsBody");
    tbody.replaceChildren();

    if (!bills.length) {
      const tr = el("tr");
      const td = el("td");
      td.colSpan = 5;
      td.textContent = "No outstanding bills.";
      tr.append(td);
      tbody.append(tr);
      return;
    }

    bills.forEach((b) => {
      const tr = el("tr");
      tr.dataset.saleId = b.saleId;
      tr.dataset.remainingP = b.remainingDueP;

      const invTd = el("td");
      invTd.append(el("strong", "", b.invoiceNo));

      const dtTd = el("td", "", U.dateTime(b.createdAt));
      const totTd = el("td", "num", U.money2(b.total));
      const dueTd = el("td", "num sum-due", U.money2(b.remainingDue));

      const allocTd = el("td", "num");
      const input = el("input", "alloc-input");
      input.type = "text";
      input.inputMode = "decimal";
      input.dataset.saleId = b.saleId;
      input.dataset.invoiceNo = b.invoiceNo;
      input.dataset.maxP = b.remainingDueP;
      input.placeholder = "0.00";
      input.style.width = "6.5rem";
      input.style.textAlign = "right";

      if (preselectedSaleId === b.saleId) {
        input.value = b.remainingDue.toFixed(2);
      }

      input.addEventListener("input", onManualAllocationChange);
      allocTd.append(input);

      tr.append(invTd, dtTd, totTd, dueTd, allocTd);
      tbody.append(tr);
    });

    updateAllocationSummary();
  }

  function onManualAllocationChange() {
    let sumAllocP = 0;
    const inputs = $("repayBillsBody").querySelectorAll(".alloc-input");
    inputs.forEach((inp) => {
      const v = U.parseMoney(inp.value);
      if (Number.isFinite(v) && v > 0) sumAllocP += Math.round(v * 100);
    });
    if (!$("repayAmount").value || document.activeElement !== $("repayAmount")) {
      $("repayAmount").value = sumAllocP > 0 ? (sumAllocP / 100).toFixed(2) : "";
    }
    updateAllocationSummary();
  }

  function updateBillAllocationsFromTotal(totalAmt) {
    const bills = getCustomerOutstandingBills(repayCustomerId);
    const { allocations } = autoAllocate(bills, totalAmt);

    const inputs = $("repayBillsBody").querySelectorAll(".alloc-input");
    inputs.forEach((inp) => {
      const match = allocations.find((a) => a.saleId === inp.dataset.saleId);
      inp.value = match && match.amount > 0 ? match.amount.toFixed(2) : "";
    });

    updateAllocationSummary();
  }

  function updateAllocationSummary() {
    let sumAllocP = 0;
    const inputs = $("repayBillsBody").querySelectorAll(".alloc-input");
    inputs.forEach((inp) => {
      const v = U.parseMoney(inp.value);
      if (Number.isFinite(v) && v > 0) sumAllocP += Math.round(v * 100);
    });
    $("repayAllocSum").textContent = U.money2(sumAllocP / 100);
  }

  async function onRepaymentFormSubmit(e) {
    e.preventDefault();
    if (repayBusy) return;

    // Phase 1: Review / Confirmation Step
    if (!repaymentPendingData) {
      const amt = U.parseMoney($("repayAmount").value);
      if (Number.isNaN(amt) || amt <= 0) {
        $("repayError").textContent = "Please enter a repayment amount above 0.";
        $("repayError").hidden = false;
        return;
      }

      const bal = getCustomerBalance(repayCustomerId);
      if (amt > bal) {
        $("repayError").textContent = "Repayment amount (" + U.money2(amt) + ") cannot exceed total balance (" + U.money2(bal) + ").";
        $("repayError").hidden = false;
        return;
      }

      // Read allocations
      const allocations = [];
      let totalAllocP = 0;
      const inputs = $("repayBillsBody").querySelectorAll(".alloc-input");
      for (const inp of inputs) {
        const val = inp.value.trim() ? U.parseMoney(inp.value) : 0;
        if (Number.isNaN(val) || val < 0) {
          $("repayError").textContent = "Invalid amount entered for bill " + inp.dataset.invoiceNo;
          $("repayError").hidden = false;
          return;
        }
        const valP = Math.round(val * 100);
        const maxP = Number(inp.dataset.maxP);
        if (valP > maxP) {
          $("repayError").textContent = "Allocated amount for " + inp.dataset.invoiceNo + " cannot exceed remaining due (" + U.money2(maxP / 100) + ").";
          $("repayError").hidden = false;
          return;
        }
        if (valP > 0) {
          totalAllocP += valP;
          allocations.push({
            saleId: inp.dataset.saleId,
            invoiceNo: inp.dataset.invoiceNo,
            amount: valP / 100
          });
        }
      }

      const amtP = Math.round(amt * 100);
      if (totalAllocP !== amtP) {
        $("repayError").textContent = "The sum of bill allocations (" + U.money2(totalAllocP / 100) + ") must match total repayment (" + U.money2(amt) + "). Tap 'Auto-allocate' to distribute automatically.";
        $("repayError").hidden = false;
        return;
      }

      $("repayError").hidden = true;

      // Show Confirmation Step
      repaymentPendingData = {
        customerId: repayCustomerId,
        amount: amt,
        method: $("repayMethod").value,
        note: $("repayNote").value.trim(),
        allocations: allocations
      };

      const c = getCustomer(repayCustomerId);
      const confBox = $("repayConfirmBox");
      confBox.replaceChildren();

      const dl = el("dl", "kv");
      dl.append(
        el("dt", "", "Customer"), el("dd", "", c.name),
        el("dt", "", "Repayment Amount"), el("dd", "sum-due", U.money2(amt)),
        el("dt", "", "Payment Method"), el("dd", "", U.METHODS[repaymentPendingData.method] || repaymentPendingData.method),
        el("dt", "", "Allocated Across"), el("dd", "", allocations.map((a) => a.invoiceNo + " (" + U.money2(a.amount) + ")").join(", ")),
        el("dt", "", "Remaining Udhaar"), el("dd", "", U.money2(bal - amt))
      );
      confBox.append(el("strong", "", "Please verify the repayment details:"), dl);
      confBox.hidden = false;

      $("repayInputSection").hidden = true;
      $("repaySubmitBtn").textContent = "Confirm & Save Repayment";
      return;
    }

    // Phase 2: Execution & Commit
    repayBusy = true;
    $("repaySubmitBtn").disabled = true;
    $("repaySubmitBtn").textContent = "Saving…";

    try {
      const result = await recordRepayment(repaymentPendingData);
      $("repaymentDialog").close();
      await refresh();
      if (window.DukaanSales) await window.DukaanSales.refresh();

      U.toast("Repayment recorded: " + U.money2(result.repayment.amount) + " (" + result.repayment.receiptNo + ")");

      if (currentCustomerId === repayCustomerId) {
        renderCustomerProfile(getCustomer(repayCustomerId));
      }

      openRepaymentReceipt(result.repayment, result.customer, result.remainingBalance);
    } catch (err) {
      $("repayError").textContent = err.message;
      $("repayError").hidden = false;
      repaymentPendingData = null;
      $("repayConfirmBox").hidden = true;
      $("repayInputSection").hidden = false;
      $("repaySubmitBtn").textContent = "Review Repayment";
    } finally {
      repayBusy = false;
      $("repaySubmitBtn").disabled = false;
    }
  }

  /* ---------- Repayment Receipt Dialog ---------- */

  let currentReceiptData = null;

  function openRepaymentReceipt(repayment, customer, remainingBalance) {
    currentReceiptData = { repayment, customer, remainingBalance };

    $("rrTitle").textContent = "Repayment Receipt " + repayment.receiptNo;
    const preview = $("rrPreview");
    preview.replaceChildren(window.DukaanReceipt.buildRepayment(repayment, customer, remainingBalance, "compact"));

    $("repaymentReceiptDialog").showModal();
  }

  /* ---------- Init & Wiring ---------- */

  function init() {
    $("custSearch").addEventListener("input", (e) => {
      customerListSearch = e.target.value;
      renderCustomerList();
    });

    $("custFilter").addEventListener("change", (e) => {
      customerListFilter = e.target.value;
      renderCustomerList();
    });

    $("addCustBtn").addEventListener("click", () => openCustomerDialog());
    $("cdBackBtn").addEventListener("click", hideCustomerDetail);

    $("cdEditBtn").addEventListener("click", () => {
      if (currentCustomerId) openCustomerDialog(currentCustomerId);
    });

    $("cdArchiveBtn").addEventListener("click", async () => {
      if (!currentCustomerId) return;
      const c = getCustomer(currentCustomerId);
      if (!c) return;
      const toArchive = c.status === "active";
      const confirmMsg = toArchive
        ? "Archive customer “" + c.name + "”? Transaction history and ledger records will be preserved."
        : "Restore customer “" + c.name + "” to active status?";
      if (!window.confirm(confirmMsg)) return;

      try {
        await toggleArchive(currentCustomerId, toArchive);
        await refresh();
        U.toast(toArchive ? "Customer archived." : "Customer restored.");
        renderCustomerProfile(getCustomer(currentCustomerId));
      } catch (e) {
        U.toast("Error: " + e.message);
      }
    });

    $("cdRepayBtn").addEventListener("click", () => {
      if (currentCustomerId) openRepaymentDialog(currentCustomerId);
    });

    // Ledger filters
    ["cdLFrom", "cdLTo", "cdLType"].forEach((id) => {
      $(id).addEventListener("change", () => {
        if (currentCustomerId) renderLedgerTable(currentCustomerId);
      });
    });

    $("cdLClearFilter").addEventListener("click", () => {
      $("cdLFrom").value = "";
      $("cdLTo").value = "";
      $("cdLType").value = "";
      if (currentCustomerId) renderLedgerTable(currentCustomerId);
    });

    // Customer Form
    $("customerForm").addEventListener("submit", onCustomerFormSubmit);
    $("custCancelBtn").addEventListener("click", () => $("customerDialog").close());

    // Repayment Form
    $("repayForm").addEventListener("submit", onRepaymentFormSubmit);
    $("repayCancelBtn").addEventListener("click", () => {
      if (repaymentPendingData) {
        repaymentPendingData = null;
        $("repayConfirmBox").hidden = true;
        $("repayInputSection").hidden = false;
        $("repaySubmitBtn").textContent = "Review Repayment";
      } else {
        $("repaymentDialog").close();
      }
    });

    $("repayAmount").addEventListener("input", (e) => {
      const a = U.parseMoney(e.target.value);
      if (Number.isFinite(a) && a > 0) {
        updateBillAllocationsFromTotal(a);
      }
    });

    $("repayAutoAllocBtn").addEventListener("click", () => {
      const a = U.parseMoney($("repayAmount").value);
      if (Number.isFinite(a) && a > 0) {
        updateBillAllocationsFromTotal(a);
      }
    });

    $("repayPayFullBtn").addEventListener("click", () => {
      const bal = getCustomerBalance(repayCustomerId);
      if (bal > 0) {
        $("repayAmount").value = bal.toFixed(2);
        updateBillAllocationsFromTotal(bal);
      }
    });

    // Repayment Receipt dialog actions
    $("rrClose").addEventListener("click", () => $("repaymentReceiptDialog").close());
    $("rrPrint").addEventListener("click", () => {
      if (currentReceiptData) {
        window.DukaanReceipt.printRepayment(currentReceiptData.repayment, currentReceiptData.customer, currentReceiptData.remainingBalance, "compact");
      }
    });
    $("rrPrintA4").addEventListener("click", () => {
      if (currentReceiptData) {
        window.DukaanReceipt.printRepayment(currentReceiptData.repayment, currentReceiptData.customer, currentReceiptData.remainingBalance, "a4");
      }
    });

    // Listen to sales changes
    document.addEventListener("sales-changed", () => {
      refresh().then(() => {
        if (currentCustomerId) {
          const c = getCustomer(currentCustomerId);
          if (c) renderCustomerProfile(c);
        } else {
          renderCustomerList();
        }
      });
    });

    refresh().then(renderCustomerList);
  }

  document.addEventListener("DOMContentLoaded", init);

  window.DukaanCustomers = {
    refresh: refresh,
    list: listCustomers,
    get: getCustomer,
    save: saveCustomer,
    archive: toggleArchive,
    getLedger: getCustomerLedger,
    getBalance: getCustomerBalance,
    totalCreditOutstanding: totalCreditOutstanding,
    getOutstandingBills: getCustomerOutstandingBills,
    recordRepayment: recordRepayment,
    openAddDialog: openCustomerDialog,
    openRepaymentDialog: openRepaymentDialog,
    showCustomerDetail: showCustomerDetail
  };
})();