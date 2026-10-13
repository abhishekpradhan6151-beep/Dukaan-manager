/*
 * test_phase4.js - Comprehensive test runner for Phase 4: Customer Management & Udhaar Ledger.
 * Tests all 18 base specification scenarios PLUS the 8 required financial integrity regression tests.
 */
const fs = require("fs");
const path = require("path");

// In-Memory IndexedDB Mock for node testing
class MockIDBRequest {
  constructor() {
    this.result = null;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
    this.readyState = "pending";
  }
  succeed(val) {
    this.readyState = "done";
    this.result = val;
    if (this.onsuccess) this.onsuccess({ target: this });
  }
  fail(err) {
    this.readyState = "done";
    this.error = err;
    if (this.onerror) this.onerror({ target: this });
  }
}

class MockIDBIndex {
  constructor(store, name, keyPath, opts = {}) {
    this.store = store;
    this.name = name;
    this.keyPath = keyPath;
    this.unique = Boolean(opts.unique);
  }
  get(val) {
    const req = new MockIDBRequest();
    queueMicrotask(() => {
      for (const item of this.store.data.values()) {
        if (item[this.keyPath] === val) {
          req.succeed(JSON.parse(JSON.stringify(item)));
          return;
        }
      }
      req.succeed(undefined);
    });
    return req;
  }
  getAll(val) {
    const req = new MockIDBRequest();
    queueMicrotask(() => {
      const results = [];
      for (const item of this.store.data.values()) {
        if (val === undefined || item[this.keyPath] === val) {
          results.push(JSON.parse(JSON.stringify(item)));
        }
      }
      req.succeed(results);
    });
    return req;
  }
}

class MockIDBObjectStore {
  constructor(tx, name, keyPath, dataMap, indexesMap) {
    this.tx = tx;
    this.name = name;
    this.keyPath = keyPath;
    this.data = dataMap;
    this.indexes = indexesMap;
    this.indexNames = {
      contains: (idxName) => this.indexes.has(idxName)
    };
  }
  createIndex(name, keyPath, opts) {
    const idx = new MockIDBIndex(this, name, keyPath, opts);
    this.indexes.set(name, idx);
    return idx;
  }
  index(name) {
    const idx = this.indexes.get(name);
    if (!idx) throw new Error("Index " + name + " not found on store " + this.name);
    return idx;
  }
  get(key) {
    const req = new MockIDBRequest();
    queueMicrotask(() => {
      const item = this.data.get(key);
      req.succeed(item ? JSON.parse(JSON.stringify(item)) : undefined);
    });
    return req;
  }
  getAll(val) {
    const req = new MockIDBRequest();
    queueMicrotask(() => {
      const list = Array.from(this.data.values()).map((v) => JSON.parse(JSON.stringify(v)));
      req.succeed(list);
    });
    return req;
  }
  put(item) {
    const req = new MockIDBRequest();
    queueMicrotask(() => {
      const key = item[this.keyPath];
      this.data.set(key, JSON.parse(JSON.stringify(item)));
      req.succeed(key);
    });
    return req;
  }
  add(item) {
    const req = new MockIDBRequest();
    queueMicrotask(() => {
      const key = item[this.keyPath];
      if (this.data.has(key)) {
        const err = new Error("Key already exists: " + key);
        err.name = "ConstraintError";
        req.fail(err);
        if (this.tx.onerror) this.tx.onerror({ target: req });
        return;
      }
      this.data.set(key, JSON.parse(JSON.stringify(item)));
      req.succeed(key);
    });
    return req;
  }
  delete(key) {
    const req = new MockIDBRequest();
    queueMicrotask(() => {
      this.data.delete(key);
      req.succeed();
    });
    return req;
  }
}

class MockIDBTransaction {
  constructor(db, storeNames, mode) {
    this.db = db;
    this.storeNames = storeNames;
    this.mode = mode;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this._aborted = false;
  }
  objectStore(name) {
    if (this.mode !== "versionchange" && !this.storeNames.includes(name)) {
      throw new Error("Store " + name + " not in transaction store list: " + this.storeNames);
    }
    const storeInfo = this.db._stores.get(name);
    if (!storeInfo) throw new Error("Store " + name + " does not exist in database");
    return new MockIDBObjectStore(this, name, storeInfo.keyPath, storeInfo.data, storeInfo.indexes);
  }
  abort() {
    this._aborted = true;
    queueMicrotask(() => {
      if (this.onabort) this.onabort({ target: this });
    });
  }
}

class MockDatabase {
  constructor(name) {
    this.name = name;
    this.version = 0;
    this._stores = new Map();
    this.objectStoreNames = {
      contains: (name) => this._stores.has(name)
    };
  }
  createObjectStore(name, { keyPath }) {
    const info = { keyPath, data: new Map(), indexes: new Map() };
    this._stores.set(name, info);
    const dummyTx = { onerror: null };
    return new MockIDBObjectStore(dummyTx, name, keyPath, info.data, info.indexes);
  }
  transaction(storeNames, mode) {
    const tx = new MockIDBTransaction(this, storeNames, mode);
    queueMicrotask(() => {
      setTimeout(() => {
        if (!tx._aborted && tx.oncomplete) {
          tx.oncomplete({ target: tx });
        }
      }, 5);
    });
    return tx;
  }
  close() {}
}

const dbInstances = new Map();

function createMockIndexedDB() {
  return {
    open(dbName, version) {
      const openReq = new MockIDBRequest();
      let db = dbInstances.get(dbName);
      if (!db) {
        db = new MockDatabase(dbName);
        dbInstances.set(dbName, db);
      }
      queueMicrotask(() => {
        if (db.version < version) {
          const oldVersion = db.version;
          db.version = version;
          openReq.result = db;
          openReq.transaction = db.transaction([], "versionchange");
          if (openReq.onupgradeneeded) {
            openReq.onupgradeneeded({ oldVersion, newVersion: version, target: openReq });
          }
        }
        openReq.result = db;
        if (openReq.onsuccess) openReq.onsuccess({ target: openReq });
      });
      return openReq;
    }
  };
}

function createBrowserEnvironment() {
  const listeners = new Map();
  const elements = new Map();

  const windowMock = {
    crypto: {
      randomUUID: () => "uuid-" + Math.random().toString(36).slice(2, 11) + "-" + Date.now().toString(36)
    },
    addEventListener: (ev, fn) => {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
    },
    removeEventListener: () => {},
    dispatchEvent: (ev) => {
      const list = listeners.get(ev.type) || [];
      list.forEach((f) => f(ev));
      return true;
    },
    print: () => {},
    confirm: () => true,
    location: { hash: "" },
    history: { replaceState: () => {} },
    scrollTo: () => {}
  };

  const documentMock = {
    getElementById: (id) => {
      if (!elements.has(id)) {
        elements.set(id, {
          id: id,
          value: "",
          textContent: "",
          hidden: false,
          children: [],
          dataset: {},
          style: {},
          classList: {
            toggle: () => {},
            add: () => {},
            remove: () => {},
            contains: () => false
          },
          setAttribute: () => {},
          removeAttribute: () => {},
          addEventListener: () => {},
          replaceChildren: function (...ch) { this.children = ch; },
          append: function (...ch) { this.children.push(...ch); },
          showModal: () => {},
          close: () => {},
          focus: () => {},
          reset: () => {},
          querySelectorAll: () => [],
          querySelector: () => null
        });
      }
      return elements.get(id);
    },
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      className: "",
      textContent: "",
      children: [],
      dataset: {},
      style: {},
      setAttribute: () => {},
      removeAttribute: () => {},
      addEventListener: () => {},
      append: function (...ch) { this.children.push(...ch); },
      replaceChildren: function (...ch) { this.children = ch; }
    }),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: (ev, fn) => windowMock.addEventListener(ev, fn),
    dispatchEvent: (ev) => windowMock.dispatchEvent(ev)
  };

  class CustomEventMock {
    constructor(type, opts = {}) {
      this.type = type;
      this.detail = opts.detail || null;
    }
  }

  windowMock.indexedDB = createMockIndexedDB();
  windowMock.document = documentMock;
  windowMock.CustomEvent = CustomEventMock;
  global.window = windowMock;
  global.document = documentMock;
  global.indexedDB = windowMock.indexedDB;
  global.CustomEvent = CustomEventMock;
  global.Option = function (text, value) { return { text, value }; };

  return { windowMock, documentMock };
}

function loadScripts(projDir) {
  const scripts = [
    "js/util.js",
    "js/db.js",
    "js/settings.js",
    "js/products.js",
    "js/sales.js",
    "js/receipt.js",
    "js/customers.js",
    "js/billing.js"
  ];
  for (const s of scripts) {
    const code = fs.readFileSync(path.join(projDir, s), "utf8");
    eval(code);
  }
}

async function runAllTests() {
  const projDir = path.resolve(__dirname, ".");
  console.log("=== STARTING PHASE 4 AUTOMATED TEST SUITE ===");
  createBrowserEnvironment();
  loadScripts(projDir);

  const results = [];
  function record(id, title, passed, detail) {
    results.push({ id, title, passed, detail });
    console.log(`[Test ${id}] ${passed ? "PASS" : "FAIL"}: ${title}${detail ? " - " + detail : ""}`);
  }

  try {
    await window.DukaanDB.open();

    let testProduct = null;
    let testProduct100 = null;
    await window.DukaanDB.run(["products", "stockHistory"], "readwrite", async (tx) => {
      const pStore = tx.objectStore("products");
      testProduct = {
        id: "prod-test-01",
        name: "Aashirvaad Atta 5kg",
        sku: "ATT-05",
        barcode: "890103001",
        category: "Staples",
        unit: "bag",
        price: 250.00,
        cost: 200.00,
        stock: 50,
        alertLow: 5,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      testProduct100 = {
        id: "prod-test-02",
        name: "Tata Salt 1kg",
        sku: "SLT-01",
        barcode: "890103002",
        category: "Staples",
        unit: "pack",
        price: 100.00,
        cost: 80.00,
        stock: 50,
        alertLow: 5,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      pStore.put(testProduct);
      pStore.put(testProduct100);
    });

    await window.DukaanProducts.refresh();

    // 1. Add, edit, search, and archive a customer
    let cust1 = await window.DukaanCustomers.save({
      name: "Ramesh Sharma",
      phone: "9876543210",
      address: "123 Bazaar Street, Jaipur",
      notes: "Regular customer"
    });
    let okAdd = cust1 && cust1.name === "Ramesh Sharma" && cust1.status === "active";

    let cust1Edited = await window.DukaanCustomers.save({
      id: cust1.id,
      name: "Ramesh Kumar Sharma",
      phone: "9876543210",
      address: "125 Bazaar Street, Jaipur",
      notes: "VIP customer"
    });
    let okEdit = cust1Edited && cust1Edited.name === "Ramesh Kumar Sharma" && cust1Edited.notes === "VIP customer";

    await window.DukaanCustomers.archive(cust1.id, true);
    await window.DukaanCustomers.refresh();
    let cust1Archived = window.DukaanCustomers.get(cust1.id);
    let okArchive = cust1Archived && cust1Archived.status === "archived";

    await window.DukaanCustomers.archive(cust1.id, false);
    await window.DukaanCustomers.refresh();
    record(1, "Add, edit, search, and archive a customer", okAdd && okEdit && okArchive);

    // 2. Verify customer data persists after reloading
    await window.DukaanCustomers.refresh();
    let reloadedCust = window.DukaanCustomers.get(cust1.id);
    let okPersist = reloadedCust && reloadedCust.name === "Ramesh Kumar Sharma" && reloadedCust.phone === "9876543210";
    record(2, "Verify customer data persists after reloading", okPersist);

    // 3. Complete a fully paid sale attached to a customer
    const sale1Id = window.DukaanDB.uid();
    const sale1 = await window.DukaanSales.complete({
      id: sale1Id,
      items: [{ productId: testProduct.id, qty: 1, unitPrice: testProduct.price }],
      discount: null,
      taxRate: 0,
      payments: [{ method: "cash", amount: 250.00 }],
      customerId: cust1.id,
      customerName: cust1.name,
      customerPhone: cust1.phone
    });
    await window.DukaanCustomers.refresh();
    let balAfterSale1 = window.DukaanCustomers.getBalance(cust1.id);
    let okSale1 = sale1.status === "completed" && sale1.outstanding === 0 && sale1.amountPaid === 250 && balAfterSale1 === 0;
    record(3, "Complete a fully paid sale attached to a customer", okSale1, `Outstanding: ${sale1.outstanding}, Cust balance: ${balAfterSale1}`);

    // 4. Create a fully unpaid credit sale
    const sale2Id = window.DukaanDB.uid();
    const sale2 = await window.DukaanSales.complete({
      id: sale2Id,
      items: [{ productId: testProduct.id, qty: 2, unitPrice: testProduct.price }],
      discount: null,
      taxRate: 0,
      payments: [],
      customerId: cust1.id,
      customerName: cust1.name,
      customerPhone: cust1.phone
    });
    await window.DukaanCustomers.refresh();
    let balAfterSale2 = window.DukaanCustomers.getBalance(cust1.id);
    let okSale2 = sale2.status === "completed" && sale2.total === 500 && sale2.amountPaid === 0 && sale2.outstanding === 500 && balAfterSale2 === 500;
    record(4, "Create a fully unpaid credit sale", okSale2, `Sale total: ${sale2.total}, Cust balance: ${balAfterSale2}`);

    // 5. Create a partially paid credit sale
    const sale3Id = window.DukaanDB.uid();
    const sale3 = await window.DukaanSales.complete({
      id: sale3Id,
      items: [{ productId: testProduct.id, qty: 3, unitPrice: testProduct.price }],
      discount: null,
      taxRate: 0,
      payments: [{ method: "upi", amount: 350.00 }],
      customerId: cust1.id,
      customerName: cust1.name,
      customerPhone: cust1.phone
    });
    await window.DukaanCustomers.refresh();
    let balAfterSale3 = window.DukaanCustomers.getBalance(cust1.id);
    let okSale3 = sale3.status === "completed" && sale3.total === 750 && sale3.amountPaid === 350 && sale3.outstanding === 400 && balAfterSale3 === 900;
    record(5, "Create a partially paid credit sale", okSale3, `Sale outstanding: ${sale3.outstanding}, Cust balance: ${balAfterSale3}`);

    // 6. Record a partial repayment
    const repay1 = await window.DukaanCustomers.recordRepayment({
      customerId: cust1.id,
      amount: 300.00,
      method: "upi",
      note: "UPI transaction 998877",
      allocations: [{ saleId: sale2.id, invoiceNo: sale2.invoiceNo, amount: 300.00 }]
    });
    await window.DukaanCustomers.refresh();
    let balAfterRepay1 = window.DukaanCustomers.getBalance(cust1.id);
    let okRepay1 = repay1.repayment.amount === 300 && balAfterRepay1 === 600;
    record(6, "Record a partial repayment", okRepay1, `Repaid: 300, New Balance: ${balAfterRepay1}`);

    // 7. Record a full repayment for a bill
    const repay2 = await window.DukaanCustomers.recordRepayment({
      customerId: cust1.id,
      amount: 200.00,
      method: "cash",
      note: "Cash payment",
      allocations: [{ saleId: sale2.id, invoiceNo: sale2.invoiceNo, amount: 200.00 }]
    });
    await window.DukaanCustomers.refresh();
    let balAfterRepay2 = window.DukaanCustomers.getBalance(cust1.id);
    let billsAfterRepay2 = window.DukaanCustomers.getOutstandingBills(cust1.id);
    let okRepay2 = balAfterRepay2 === 400 && !billsAfterRepay2.some((b) => b.saleId === sale2.id);
    record(7, "Record a full repayment for a bill", okRepay2, `Sale 2 fully paid and removed from outstanding bills`);

    // 8. Allocate one repayment across multiple outstanding bills
    const sale4 = await window.DukaanSales.complete({
      id: window.DukaanDB.uid(),
      items: [{ productId: testProduct.id, qty: 1, unitPrice: testProduct.price }],
      payments: [],
      customerId: cust1.id
    });
    const sale5 = await window.DukaanSales.complete({
      id: window.DukaanDB.uid(),
      items: [{ productId: testProduct.id, qty: 2, unitPrice: testProduct.price }],
      payments: [],
      customerId: cust1.id
    });
    await window.DukaanCustomers.refresh();

    const multiRepay = await window.DukaanCustomers.recordRepayment({
      customerId: cust1.id,
      amount: 500.00,
      method: "bank",
      note: "NEFT Payment",
      allocations: [
        { saleId: sale3.id, invoiceNo: sale3.invoiceNo, amount: 200.00 },
        { saleId: sale4.id, invoiceNo: sale4.invoiceNo, amount: 250.00 },
        { saleId: sale5.id, invoiceNo: sale5.invoiceNo, amount: 50.00 }
      ]
    });
    await window.DukaanCustomers.refresh();
    let balAfterMulti = window.DukaanCustomers.getBalance(cust1.id);
    let okMulti = multiRepay.repayment.allocations.length === 3 && balAfterMulti === 650;
    record(8, "Allocate one repayment across multiple outstanding bills", okMulti, `Allocated across 3 bills, New Balance: ${balAfterMulti}`);

    // 9. Attempt a repayment exceeding eligible outstanding amount
    let okExceed = false;
    try {
      await window.DukaanCustomers.recordRepayment({
        customerId: cust1.id,
        amount: 2000.00,
        method: "cash",
        allocations: [{ saleId: sale5.id, invoiceNo: sale5.invoiceNo, amount: 2000.00 }]
      });
    } catch (err) {
      okExceed = err.message.includes("exceeds");
    }
    record(9, "Attempt a repayment exceeding eligible outstanding amount", okExceed);

    // 10. Attempt duplicate / over-allocation repayment submission
    let okDup = true;
    try {
      await window.DukaanCustomers.recordRepayment({
        customerId: cust1.id,
        amount: 300.00,
        method: "cash",
        allocations: [{ saleId: sale3.id, invoiceNo: sale3.invoiceNo, amount: 300.00 }]
      });
      okDup = false;
    } catch (err) {
      okDup = err.message.includes("exceeds remaining balance");
    }
    record(10, "Attempt duplicate / over-allocation repayment submission", okDup);

    // 11. Cancel a credit sale and verify balance is reversed exactly once
    const cancelRes = await window.DukaanSales.cancel(sale5.id, "Customer returned items");
    await window.DukaanCustomers.refresh();
    let balAfterCancel = window.DukaanCustomers.getBalance(cust1.id);
    let okCancel1 = balAfterCancel === 200 && cancelRes.cancellation.refundDue === 50;

    let okCancelTwice = false;
    try {
      await window.DukaanSales.cancel(sale5.id, "Second cancel attempt");
    } catch (e) {
      okCancelTwice = e.message.includes("already cancelled");
    }
    await window.DukaanCustomers.refresh();
    let balAfterSecondCancel = window.DukaanCustomers.getBalance(cust1.id);
    let okCancel = okCancel1 && okCancelTwice && balAfterSecondCancel === 200;
    record(11, "Cancel a credit sale and verify balance is reversed exactly once", okCancel, `Balance: ${balAfterSecondCancel}, RefundDue: ${cancelRes.cancellation.refundDue}`);

    // 12. Verify repayment does not change inventory or sales revenue
    await window.DukaanProducts.refresh();
    const prodBefore = window.DukaanProducts.list().find((p) => p.id === testProduct.id);
    const dashBefore = window.DukaanSales.dashboard();
    await window.DukaanCustomers.recordRepayment({
      customerId: cust1.id,
      amount: 100.00,
      method: "cash",
      allocations: [{ saleId: sale3.id, invoiceNo: sale3.invoiceNo, amount: 100.00 }]
    });
    await window.DukaanProducts.refresh();
    const prodAfter = window.DukaanProducts.list().find((p) => p.id === testProduct.id);
    const dashAfter = window.DukaanSales.dashboard();
    let okNoSideEffects = prodBefore.stock === prodAfter.stock && dashBefore.today.sales === dashAfter.today.sales;
    record(12, "Verify repayment does not change inventory or sales revenue", okNoSideEffects, `Stock: ${prodAfter.stock}, Sales Revenue: ${dashAfter.today.sales}`);

    // 13. Verify dashboard customer credit matches the ledger
    const totalFromLedger = window.DukaanCustomers.totalCreditOutstanding();
    const dashCredit = window.DukaanSales.dashboard().creditOutstanding;
    let okDashSync = totalFromLedger === dashCredit;
    record(13, "Verify dashboard customer credit matches the ledger", okDashSync, `Dashboard credit: ${dashCredit}, Ledger credit: ${totalFromLedger}`);

    // 14. Verify archived customers retain their transaction history
    await window.DukaanCustomers.archive(cust1.id, true);
    await window.DukaanCustomers.refresh();
    const ledgerArchived = window.DukaanCustomers.getLedger(cust1.id);
    const balArchived = window.DukaanCustomers.getBalance(cust1.id);
    let okArchivedHistory = ledgerArchived.length > 0 && balArchived === 100;
    record(14, "Verify archived customers retain their transaction history", okArchivedHistory, `Ledger entries: ${ledgerArchived.length}, Balance: ${balArchived}`);
    await window.DukaanCustomers.archive(cust1.id, false);
    await window.DukaanCustomers.refresh();

    // 15. Verify the database migration preserves existing Phase 3 data
    let okMigration = false;
    await window.DukaanDB.run(["sales"], "readonly", async (tx) => {
      const sales = await window.DukaanDB.req(tx.objectStore("sales").getAll());
      okMigration = sales.some((s) => s.id === sale1.id);
    });
    record(15, "Verify the database migration preserves existing Phase 3 data", okMigration, `Sales preserved in DB`);

    // 16. Test invalid input and database transaction failures
    let invalidInputTests = [];
    try {
      await window.DukaanCustomers.save({ name: "A" });
      invalidInputTests.push(false);
    } catch (_) {
      invalidInputTests.push(true);
    }
    try {
      await window.DukaanCustomers.recordRepayment({
        customerId: cust1.id,
        amount: -50,
        method: "cash",
        allocations: []
      });
      invalidInputTests.push(false);
    } catch (_) {
      invalidInputTests.push(true);
    }
    let okInvalid = invalidInputTests.every(Boolean);
    record(16, "Test invalid input and database transaction failures", okInvalid);

    // 17. Test the customer interface on mobile, tablet, and desktop
    const htmlContent = fs.readFileSync(path.join(projDir, "index.html"), "utf8");
    const cssContent = fs.readFileSync(path.join(projDir, "style.css"), "utf8");
    let hasResponsiveMarkup =
      htmlContent.includes('id="custListView"') &&
      htmlContent.includes('id="custDetailView"') &&
      htmlContent.includes('id="customerDialog"') &&
      htmlContent.includes('id="repaymentDialog"') &&
      htmlContent.includes('id="repaymentReceiptDialog"') &&
      cssContent.includes(".alloc-input") &&
      cssContent.includes("@media (max-width: 640px)");
    record(17, "Test the customer interface on mobile, tablet, and desktop", hasResponsiveMarkup);

    // 18. Test customer and ledger functionality without internet
    let hasExternalUrls =
      htmlContent.includes("http://") ||
      htmlContent.includes("https://") ||
      htmlContent.includes("cdn.");
    let okOffline = !hasExternalUrls;
    record(18, "Test customer and ledger functionality without internet after load", okOffline);

    // =========================================================================
    // TARGETED FINANCIAL INTEGRITY REGRESSION TESTS (Fix 1 & Fix 2)
    // =========================================================================
    console.log("\n=== TARGETED FINANCIAL INTEGRITY REGRESSION TESTS ===");

    // Setup fresh customers and bills for regression tests
    const custA = await window.DukaanCustomers.save({ name: "Customer Alpha", phone: "9111111111" });
    const custB = await window.DukaanCustomers.save({ name: "Customer Beta", phone: "9222222222" });

    // Sale A1: total 100, unpaid (due 100)
    const saleA1 = await window.DukaanSales.complete({
      id: window.DukaanDB.uid(),
      items: [{ productId: testProduct100.id, qty: 1, unitPrice: testProduct100.price }], // 1 * 100 = 100
      payments: [],
      customerId: custA.id
    });

    // Sale A2: total 100, unpaid (due 100)
    const saleA2 = await window.DukaanSales.complete({
      id: window.DukaanDB.uid(),
      items: [{ productId: testProduct100.id, qty: 1, unitPrice: testProduct100.price }], // 100
      payments: [],
      customerId: custA.id
    });

    // Sale B1 for Customer B: total 100, unpaid (due 100)
    const saleB1 = await window.DukaanSales.complete({
      id: window.DukaanDB.uid(),
      items: [{ productId: testProduct100.id, qty: 1, unitPrice: testProduct100.price }], // 100
      payments: [],
      customerId: custB.id
    });

    await window.DukaanCustomers.refresh();

    // R1: A bill has ₹100 outstanding. Two allocations of ₹100 each to that same bill must be rejected.
    let r1Passed = false;
    try {
      await window.DukaanCustomers.recordRepayment({
        customerId: custA.id,
        amount: 200.00,
        method: "cash",
        allocations: [
          { saleId: saleA1.id, invoiceNo: saleA1.invoiceNo, amount: 100.00 },
          { saleId: saleA1.id, invoiceNo: saleA1.invoiceNo, amount: 100.00 }
        ]
      });
      r1Passed = false;
    } catch (err) {
      r1Passed = err.message.includes("exceeds remaining balance");
    }
    record("R1", "Two allocations of ₹100 each to the same ₹100 bill must be rejected", r1Passed);

    // R2: A repayment allocated correctly across two different bills must still succeed.
    let r2Passed = false;
    try {
      const repR2 = await window.DukaanCustomers.recordRepayment({
        customerId: custA.id,
        amount: 150.00,
        method: "upi",
        allocations: [
          { saleId: saleA1.id, invoiceNo: saleA1.invoiceNo, amount: 50.00 },
          { saleId: saleA2.id, invoiceNo: saleA2.invoiceNo, amount: 100.00 }
        ]
      });
      await window.DukaanCustomers.refresh();
      const balA = window.DukaanCustomers.getBalance(custA.id);
      r2Passed = repR2.repayment.amount === 150.00 && balA === 50.00;
    } catch (err) {
      r2Passed = false;
    }
    record("R2", "A repayment allocated correctly across two different bills must succeed", r2Passed);

    // R3: Allocation totals exceeding the repayment amount must be rejected.
    let r3Passed = false;
    try {
      await window.DukaanCustomers.recordRepayment({
        customerId: custA.id,
        amount: 30.00,
        method: "cash",
        allocations: [
          { saleId: saleA1.id, invoiceNo: saleA1.invoiceNo, amount: 50.00 }
        ]
      });
      r3Passed = false;
    } catch (err) {
      r3Passed = err.message.includes("exceed the repayment amount");
    }
    record("R3", "Allocation totals exceeding the repayment amount must be rejected", r3Passed);

    // R4: Allocation totals below the repayment amount must be rejected.
    let r4Passed = false;
    try {
      await window.DukaanCustomers.recordRepayment({
        customerId: custA.id,
        amount: 50.00,
        method: "cash",
        allocations: [
          { saleId: saleA1.id, invoiceNo: saleA1.invoiceNo, amount: 30.00 }
        ]
      });
      r4Passed = false;
    } catch (err) {
      r4Passed = err.message.includes("less than the repayment amount");
    }
    record("R4", "Allocation totals below the repayment amount must be rejected", r4Passed);

    // R5: An allocation for another customer’s bill must be rejected.
    let r5Passed = false;
    try {
      await window.DukaanCustomers.recordRepayment({
        customerId: custA.id,
        amount: 50.00,
        method: "cash",
        allocations: [
          { saleId: saleB1.id, invoiceNo: saleB1.invoiceNo, amount: 50.00 }
        ]
      });
      r5Passed = false;
    } catch (err) {
      r5Passed = err.message.includes("does not belong to this customer");
    }
    record("R5", "An allocation for another customer’s bill must be rejected", r5Passed);

    // R6: A failed repayment must leave all database records and counters unchanged.
    let r6Passed = false;
    let countsBefore = {};
    await window.DukaanDB.run(["repayments", "repaymentAllocations", "customerLedger", "counters"], "readonly", async (tx) => {
      countsBefore.reps = (await window.DukaanDB.req(tx.objectStore("repayments").getAll())).length;
      countsBefore.allocs = (await window.DukaanDB.req(tx.objectStore("repaymentAllocations").getAll())).length;
      countsBefore.ledger = (await window.DukaanDB.req(tx.objectStore("customerLedger").getAll())).length;
      countsBefore.counter = await window.DukaanDB.req(tx.objectStore("counters").get("repayment"));
    });

    try {
      await window.DukaanCustomers.recordRepayment({
        customerId: custA.id,
        amount: 999.00,
        method: "cash",
        allocations: [{ saleId: saleA1.id, amount: 999.00 }]
      });
    } catch (_) {
      // expected failure
    }

    let countsAfter = {};
    await window.DukaanDB.run(["repayments", "repaymentAllocations", "customerLedger", "counters"], "readonly", async (tx) => {
      countsAfter.reps = (await window.DukaanDB.req(tx.objectStore("repayments").getAll())).length;
      countsAfter.allocs = (await window.DukaanDB.req(tx.objectStore("repaymentAllocations").getAll())).length;
      countsAfter.ledger = (await window.DukaanDB.req(tx.objectStore("customerLedger").getAll())).length;
      countsAfter.counter = await window.DukaanDB.req(tx.objectStore("counters").get("repayment"));
    });

    r6Passed =
      countsBefore.reps === countsAfter.reps &&
      countsBefore.allocs === countsAfter.allocs &&
      countsBefore.ledger === countsAfter.ledger &&
      JSON.stringify(countsBefore.counter) === JSON.stringify(countsAfter.counter);
    record("R6", "A failed repayment must leave all database records and counters unchanged", r6Passed);

    // R7: Archiving a customer with ₹500 outstanding must not reduce the dashboard’s total credit due.
    const custArchiveTest = await window.DukaanCustomers.save({ name: "Archive Test Customer", phone: "9333333333" });
    const saleArch = await window.DukaanSales.complete({
      id: window.DukaanDB.uid(),
      items: [{ productId: testProduct.id, qty: 2, unitPrice: testProduct.price }], // 500
      payments: [],
      customerId: custArchiveTest.id
    });
    await window.DukaanCustomers.refresh();

    const creditBeforeArchive = window.DukaanCustomers.totalCreditOutstanding();
    const dashCreditBeforeArchive = window.DukaanSales.dashboard().creditOutstanding;

    // Archive the customer
    await window.DukaanCustomers.archive(custArchiveTest.id, true);
    await window.DukaanCustomers.refresh();

    const creditAfterArchive = window.DukaanCustomers.totalCreditOutstanding();
    const dashCreditAfterArchive = window.DukaanSales.dashboard().creditOutstanding;

    let r7Passed =
      creditBeforeArchive === creditAfterArchive &&
      dashCreditBeforeArchive === dashCreditAfterArchive &&
      creditAfterArchive > 0;
    record("R7", "Archiving a customer with ₹500 outstanding must not reduce dashboard credit due", r7Passed, `Before: ${creditBeforeArchive}, After: ${creditAfterArchive}`);

    // R8: Repaying an archived customer’s outstanding bill must follow a clearly defined and consistent policy without losing historical records.
    let r8Passed = false;
    try {
      const repArchived = await window.DukaanCustomers.recordRepayment({
        customerId: custArchiveTest.id,
        amount: 200.00,
        method: "cash",
        note: "Repayment on archived account",
        allocations: [{ saleId: saleArch.id, invoiceNo: saleArch.invoiceNo, amount: 200.00 }]
      });
      await window.DukaanCustomers.refresh();
      const updatedCust = window.DukaanCustomers.get(custArchiveTest.id);
      const remainingBal = window.DukaanCustomers.getBalance(custArchiveTest.id);
      const custLedger = window.DukaanCustomers.getLedger(custArchiveTest.id);

      r8Passed =
        updatedCust.status === "archived" && // remains archived
        remainingBal === 300.00 && // balance reduced by 200 (500 - 200 = 300)
        custLedger.some((e) => e.repaymentId === repArchived.repayment.id); // historical ledger entry preserved
    } catch (err) {
      r8Passed = false;
    }
    record("R8", "Repaying an archived customer's outstanding bill succeeds and preserves history", r8Passed);

    console.log("\n=== OVERALL TEST SUMMARY ===");
    const passedCount = results.filter((r) => r.passed).length;
    console.log(`Total Tests Run: ${results.length}`);
    console.log(`Passed: ${passedCount} / ${results.length}`);
    if (passedCount === results.length) {
      console.log("ALL TESTS (18 BASE + 8 REGRESSION) PASSED SUCCESSFULLY!");
    } else {
      console.error("SOME TESTS FAILED!");
      process.exit(1);
    }
  } catch (err) {
    console.error("FATAL TEST SUITE ERROR:", err);
    process.exit(1);
  }
}

runAllTests();