/*
 * db.js - IndexedDB storage helper (Phase 2, extended in Phase 3).
 * All business records live in IndexedDB, never in localStorage.
 * Other files call DukaanDB.run(...) so every change happens inside a
 * transaction, and success is reported only after the transaction commits.
 */
(function () {
  "use strict";

  const DB_NAME = "dukaan-manager";
  // Version 2 (Phase 3) adds sales, counters and settings. Version 4 (Phase 5) adds expenses. Version 3 (Phase 4) adds customers,
  // ledger and repayments. Each upgrade only ADDS stores, so existing data is kept as is.
  const DB_VERSION = 4;
  let dbPromise = null;

  function friendly(err) {
    if (err && err.name === "QuotaExceededError") {
      return new Error("Device storage is full. Free up space or export a backup, then try again. Nothing was saved.");
    }
    if (err && err.name === "ConstraintError") {
      return new Error("This record already exists (duplicate ID). Nothing was saved.");
    }
    if (err && err.name === "InvalidStateError") {
      return new Error("Storage is unavailable (private browsing or blocked by browser settings). Nothing was saved.");
    }
    return err instanceof Error ? err : new Error((err && err.message) || "Could not save to device storage. Nothing was saved.");
  }

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window) || !window.indexedDB) {
        reject(new Error("This browser does not support local storage (IndexedDB). Use a current version of Chrome, Edge, Firefox or Safari."));
        return;
      }
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(friendly(e));
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("products")) {
          const s = db.createObjectStore("products", { keyPath: "id" });
          s.createIndex("sku", "sku");
          s.createIndex("status", "status");
        }
        if (!db.objectStoreNames.contains("stockHistory")) {
          const s = db.createObjectStore("stockHistory", { keyPath: "id" });
          s.createIndex("productId", "productId");
        }
        // --- added in version 2 (Phase 3) ---
        if (!db.objectStoreNames.contains("sales")) {
          const s = db.createObjectStore("sales", { keyPath: "id" });
          s.createIndex("invoiceNo", "invoiceNo", { unique: true });
          s.createIndex("dateKey", "dateKey");
          s.createIndex("status", "status");
        }
        if (!db.objectStoreNames.contains("counters")) {
          db.createObjectStore("counters", { keyPath: "name" }); // invoice number counter
        }
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "key" }); // shop details
        }
        // --- added in version 3 (Phase 4): customers, ledger, repayments. Nothing existing is touched. ---
        if (!db.objectStoreNames.contains("customers")) {
          const s = db.createObjectStore("customers", { keyPath: "id" });
          s.createIndex("status", "status");
          s.createIndex("phoneKey", "phoneKey");
        }
        if (!db.objectStoreNames.contains("ledger")) {
          const s = db.createObjectStore("ledger", { keyPath: "id" });
          s.createIndex("customerId", "customerId");
          s.createIndex("refKey", "refKey");
          s.createIndex("saleId", "saleId");
          s.createIndex("repaymentId", "repaymentId");
          s.createIndex("createdAt", "createdAt");
          s.createIndex("type", "type");
        }
        if (!db.objectStoreNames.contains("repayments")) {
          const s = db.createObjectStore("repayments", { keyPath: "id" });
          s.createIndex("customerId", "customerId");
          s.createIndex("createdAt", "createdAt");
          s.createIndex("refNo", "refNo", { unique: true });
        }
        // --- added in version 4 (Phase 5): expenses. Nothing existing is touched. ---
        if (!db.objectStoreNames.contains("expenses")) {
          const s = db.createObjectStore("expenses", { keyPath: "id" });
          s.createIndex("dateKey", "dateKey");
          s.createIndex("category", "category");
          s.createIndex("status", "status");
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(friendly(req.error));
      req.onblocked = () => reject(new Error("Storage is blocked by another open Dukaan Manager tab. Close other tabs and reload."));
    });
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  // Wrap an IDBRequest in a promise.
  function req(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  /*
   * run(storeNames, mode, work)
   * Opens one transaction and calls work(tx). work may be async. The returned
   * promise resolves only after the transaction has committed. If work throws,
   * the whole transaction is rolled back.
   */
  function run(stores, mode, work) {
    return open().then((db) => new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(stores, mode);
      } catch (e) {
        reject(friendly(e));
        return;
      }
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(friendly(tx.error));
      tx.onabort = () => reject(friendly(tx.error || new Error("The save was cancelled. Nothing was saved.")));
      let out;
      try {
        out = work(tx);
      } catch (e) {
        try { tx.abort(); } catch (_) { /* already finished */ }
        reject(e);
        return;
      }
      Promise.resolve(out).then((r) => { result = r; }).catch((e) => {
        try { tx.abort(); } catch (_) { /* already finished */ }
        reject(e);
      });
    }));
  }

  function uid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  const now = () => new Date().toISOString();

  window.DukaanDB = { open, run, req, uid, now };
})();
