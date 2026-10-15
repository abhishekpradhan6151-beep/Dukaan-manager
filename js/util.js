/*
 * util.js - small shared helpers for the Phase 3 files (billing, sales,
 * history, receipt, settings). Nothing here touches the database.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // Build an element. Text goes in with textContent, so user-typed text can never run as HTML.
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const round = (n, d) => { const f = Math.pow(10, d); return Math.round((n + Number.EPSILON) * f) / f; };

  const moneyFmt = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const money2Fmt = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qtyFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });
  const dateTimeFmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
  const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });

  const money = (n) => moneyFmt.format(n);     // 1,200 or 1,200.50
  const money2 = (n) => money2Fmt.format(n);   // always 2 decimals (receipts)
  const qty = (n, unit) => qtyFmt.format(n) + (unit ? " " + unit : "");
  const dateTime = (iso) => { try { return dateTimeFmt.format(new Date(iso)); } catch (_) { return String(iso); } };
  // "YYYY-MM-DD" in Indian time. Used for "today" and date filters.
  const dateKey = (iso) => dayFmt.format(new Date(iso));
  const todayKey = () => dateKey(new Date().toISOString());

  // Strict number parsing (digits, optional decimals). NaN means invalid.
  const parseMoney = (s) => { s = String(s).trim(); return /^\d{1,9}(\.\d{1,2})?$/.test(s) ? Number(s) : NaN; };
  const parseQty = (s) => { s = String(s).trim(); return /^\d{1,7}(\.\d{1,3})?$/.test(s) ? Number(s) : NaN; };
  const parsePercent = (s) => {
    s = String(s).trim();
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return NaN;
    const n = Number(s);
    return n <= 100 ? n : NaN;
  };

  const METHODS = {
    cash: "Cash",
    upi: "UPI (recorded)",
    card: "Card (recorded)",
    bank: "Bank transfer (recorded)"
  };
  const METHOD_SHORT = { cash: "Cash", upi: "UPI", card: "Card", bank: "Bank" };

  // One short word describing how a sale was paid, for lists.
  // dueNow (optional) is what is still owed on the bill today, from the customer ledger.
  function paymentSummary(sale, dueNow) {
    if (sale.status === "cancelled") return { label: "Cancelled", cls: "out" };
    if (sale.outstanding > 0) {
      const due = typeof dueNow === "number" ? dueNow : sale.outstanding;
      if (due <= 0) return { label: "Udhaar cleared", cls: "" };
      return sale.payments.length ? { label: "Part paid", cls: "credit" } : { label: "Udhaar", cls: "credit" };
    }
    if (!sale.payments.length) return { label: "Udhaar", cls: "credit" };
    const kinds = Array.from(new Set(sale.payments.map((p) => p.method)));
    return kinds.length === 1 ? { label: METHOD_SHORT[kinds[0]] || kinds[0], cls: "" } : { label: "Split", cls: "" };
  }

  /* CSV: quote every cell, and neutralise spreadsheet formulas (= + - @). */
  function csvCell(val) {
    let s = val === null || val === undefined ? "" : String(val);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function toCsv(rows) { return rows.map((r) => r.map(csvCell).join(",")).join("\r\n"); }
  function downloadCsv(filename, rows) {
    const blob = new Blob(["﻿" + toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /*
   * ask(message, okLabel) - an in-page replacement for window.confirm(). The browser's own confirm()
   * is silently answered "No" in embedded browsers, preview frames and when a page has dialogs blocked,
   * which made Save / Complete sale / Archive do nothing. Resolves true only when OK is pressed.
   */
  function ask(message, okLabel, withReason) {
    const d = $("askDialog");
    if (!d || typeof d.showModal !== "function") return Promise.resolve(withReason ? window.prompt(message) : window.confirm(message));
    return new Promise((resolve) => {
      $("askMsg").textContent = message;
      $("askOk").textContent = okLabel || "OK";
      $("askInput").hidden = !withReason; $("askInput").value = "";
      let answer = false;
      const ok = () => { answer = true; d.close(); };
      const no = () => d.close();
      $("askOk").addEventListener("click", ok);
      $("askNo").addEventListener("click", no);
      d.addEventListener("close", () => {
        $("askOk").removeEventListener("click", ok);
        $("askNo").removeEventListener("click", no);
        resolve(withReason ? (answer ? $("askInput").value.trim() : null) : answer);
      }, { once: true });
      d.showModal();
      if (withReason) $("askInput").focus(); else $("askNo").focus();
    });
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  window.DukaanUtil = {
    $, el, round, money, money2, qty, dateTime, dateKey, todayKey,
    parseMoney, parseQty, parsePercent, METHODS, METHOD_SHORT, paymentSummary, toast, ask,
    csvCell, toCsv, downloadCsv
  };
})();
