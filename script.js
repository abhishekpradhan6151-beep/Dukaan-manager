/*
 * Dukaan Manager - navigation and dashboard.
 * Products live in js/products.js; sales, billing, history and receipts live in
 * js/sales.js, js/billing.js, js/history.js and js/receipt.js. The dashboard
 * below is calculated from the saved sales and products (no sample numbers).
 */
(function () {
  "use strict";

  const U = window.DukaanUtil;

  const PAGES = [
    { id: "dashboard", label: "Dashboard", icon: "⌂" },
    { id: "sale", label: "New Sale", icon: "✚" },
    { id: "products", label: "Products", icon: "▦" },
    { id: "sales", label: "Sales History", icon: "☰" },
    { id: "customers", label: "Customers & Udhaar", icon: "☺" },
    { id: "expenses", label: "Expenses", icon: "₹" },
    { id: "reports", label: "Reports", icon: "∑" },
    { id: "settings", label: "Settings & Backup", icon: "⚙" }
  ];
  const BOTTOM = [
    { id: "dashboard", label: "Home" },
    { id: "sale", label: "Sale" },
    { id: "products", label: "Products" },
    { id: "customers", label: "Udhaar" }
  ];

  const $ = (id) => document.getElementById(id);
  const el = U.el;
  // whole rupees stay short (₹100); amounts with paise always show two decimals (₹423.90)
  const fmt = (n) => (Number.isInteger(n) ? U.money(n) : U.money2(n));

  /* ---------- Navigation ---------- */
  function navButton(p, label, icon) {
    const li = el("li");
    const b = el("button", "nav-link");
    b.type = "button";
    b.dataset.page = p;
    const i = el("span", "nav-ico", icon || "");
    i.setAttribute("aria-hidden", "true");
    b.append(i, el("span", "nav-text", label));
    b.addEventListener("click", () => go(p));
    li.append(b);
    return li;
  }

  function buildNav() {
    PAGES.forEach((p) => $("navList").append(navButton(p.id, p.label, p.icon)));
    BOTTOM.forEach((b) => {
      const icon = PAGES.find((p) => p.id === b.id).icon;
      $("bottomNav").append(navButton(b.id, b.label, icon));
    });
    const li = el("li");
    const more = el("button", "nav-link");
    more.type = "button";
    const i = el("span", "nav-ico", "⋯");
    i.setAttribute("aria-hidden", "true");
    more.append(i, el("span", "nav-text", "More"));
    more.addEventListener("click", () => toggleMenu(true));
    li.append(more);
    $("bottomNav").append(li);
  }

  function go(raw) {
    // "customers/<id>" opens one customer; the page itself is "customers"
    const slash = String(raw || "").indexOf("/");
    const page = slash > 0 ? raw.slice(0, slash) : raw;
    const sub = slash > 0 ? raw.slice(slash + 1) : "";
    return goPage(PAGES.some((p) => p.id === page) ? page : "dashboard", page === "customers" ? sub : "");
  }

  function goPage(page, sub) {
    PAGES.forEach((p) => { $("view-" + p.id).hidden = p.id !== page; });
    document.querySelectorAll(".nav-link[data-page]").forEach((b) => {
      if (b.dataset.page === page) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    const title = PAGES.find((p) => p.id === page).label;
    document.title = title + " – Dukaan Manager";
    const want = "#" + page + (sub ? "/" + sub : "");
    if (location.hash !== want) history.replaceState(null, "", want);
    if (page === "customers" && window.DukaanCustomers) window.DukaanCustomers.route(sub);
    toggleMenu(false);
    window.scrollTo(0, 0);
    $("main").focus();
  }

  function toggleMenu(open) {
    $("sidebar").classList.toggle("open", open);
    $("scrim").hidden = !open;
    $("menuBtn").setAttribute("aria-expanded", String(open));
  }

  /* ---------- Dashboard (live, from saved sales and products) ---------- */
  function card(label, value, hint, accent) {
    const c = el("div", "card" + (accent ? " accent-" + accent : ""));
    c.append(el("div", "card-label", label), el("div", "card-value", value), el("div", "card-hint", hint));
    return c;
  }

  function salesData() {
    const S = window.DukaanSales;
    if (!S) return { state: "loading" };
    const st = S.status();
    if (st === "failed") return { state: "failed" };
    if (st !== "ready") return { state: "loading" };
    return { state: "ready", d: S.dashboard() };
  }

  function expenseCard() {
    const X = window.DukaanExpenses;
    if (!X || X.status() === "loading") return card("Expenses", "…", "Loading", "gold");
    if (X.status() === "failed") return card("Expenses", "–", "Storage unavailable", "warn");
    const k = U.todayKey();
    return card("Expenses", fmt(X.totalP(X.inRange(k, k)) / 100), "Recorded today. Voided ones excluded.", "gold");
  }

  function renderMoneyCards() {
    const wrap = $("cardsMoney");
    wrap.replaceChildren();
    const s = salesData();
    if (s.state !== "ready") {
      const failed = s.state === "failed";
      ["Total sales", "Cash received", "UPI recorded", "Card / bank recorded", "Credit sales", "Expenses", "Est. gross profit"]
        .forEach((l) => wrap.append(card(l, failed ? "–" : "…", failed ? "Storage unavailable" : "Loading", failed ? "warn" : "")));
      return;
    }
    const t = s.d.today;
    wrap.append(
      card("Total sales", fmt(t.sales), t.count + (t.count === 1 ? " bill" : " bills") + " today (revenue)"),
      card("Cash received", fmt(t.cash), "Cash taken on today’s bills", "teal"),
      card("UPI recorded", fmt(t.upi), "Recorded by you, not verified", "teal"),
      card("Card / bank recorded", fmt(t.other), "Recorded by you, not verified", "teal"),
      card("Credit sales", fmt(t.credit), "Unpaid part of today’s bills (udhaar)", "gold"),
      expenseCard(),
      card("Est. gross profit", fmt(t.gross), t.costMissing ? "Estimate. Some items have no cost, so profit may be overstated." : "Estimate, before expenses")
    );
  }

  // Product counts and credit due are live. Credit due comes from the customer ledger.
  function renderStockCards() {
    const wrap = $("cardsStock");
    wrap.replaceChildren();
    const live = window.DukaanProducts && window.DukaanProducts.stats();
    if (live && live.failed) {
      wrap.append(
        card("Total products", "–", "Storage unavailable", "warn"),
        card("Low stock", "–", "Storage unavailable", "warn")
      );
    } else if (live) {
      wrap.append(
        card("Total products", String(live.total), "Live: active products on this device"),
        card("Low stock", String(live.low), "Live: at or below alert level", "warn")
      );
    } else {
      wrap.append(card("Total products", "…", "Loading"), card("Low stock", "…", "Loading", "warn"));
    }
    const s = salesData();
    if (s.state === "ready") {
      wrap.append(card("Customer credit due", fmt(s.d.creditOutstanding), "From customer ledgers. Cancelled bills are not counted.", "gold"));
      if (s.d.unlinkedCredit > 0) {
        wrap.append(card("Unlinked earlier credit", fmt(s.d.unlinkedCredit), "From bills made before customer records. Link them on the Customers page.", "warn"));
      }
      wrap.append(card("Repayments received", fmt(s.d.repaymentsToday), "Today. Not counted in sales.", "teal"));
    } else {
      wrap.append(card("Customer credit due", s.state === "failed" ? "–" : "…", s.state === "failed" ? "Storage unavailable" : "Loading", "gold"));
    }
  }

  function viewButton(sale) {
    const b = el("button", "btn btn-sm", "View");
    b.type = "button";
    b.setAttribute("aria-label", "View invoice " + sale.invoiceNo);
    b.addEventListener("click", () => window.DukaanHistory.showSale(sale.id));
    return b;
  }

  function renderRecent() {
    const wrap = $("recentWrap");
    wrap.replaceChildren();
    const s = salesData();
    if (s.state === "loading") { wrap.append(el("p", "muted", "Loading…")); return; }
    if (s.state === "failed") { wrap.append(el("p", "alert", window.DukaanSales.error() + " Recent sales are unavailable.")); return; }
    const rows = s.d.recent;
    if (!rows.length) {
      const e = el("div", "empty-state");
      e.append(el("h2", "", "No transactions yet"), el("p", "", "Completed sales will appear here."));
      const b = el("button", "btn btn-primary", "+ Make your first sale");
      b.type = "button"; b.style.marginTop = ".8rem";
      b.addEventListener("click", () => go("sale"));
      e.append(b);
      wrap.append(e);
      return;
    }
    // Table (tablet/desktop)
    const tw = el("div", "table-wrap");
    const table = el("table");
    table.append(el("caption", "sr-only", "Recent sales"));
    const thead = el("thead");
    const hr = el("tr");
    ["Invoice", "Date & time", "Customer", "Payment", "Amount", "Actions"].forEach((h, i) => {
      const th = el("th", i === 4 ? "num" : "", h);
      th.scope = "col";
      hr.append(th);
    });
    thead.append(hr);
    const tbody = el("tbody");
    const list = el("div", "tx-list");
    rows.forEach((r) => {
      const pay = U.paymentSummary(r, window.DukaanLedger ? window.DukaanLedger.dueForSale(r) : undefined);
      const tr = el("tr");
      const badgeTd = el("td");
      badgeTd.append(el("span", "badge" + (pay.cls ? " " + pay.cls : ""), pay.label));
      const actTd = el("td"); actTd.append(viewButton(r));
      tr.append(el("td", "", r.invoiceNo), el("td", "", U.dateTime(r.createdAt)), el("td", "", r.customerName || "Walk-in"), badgeTd, el("td", "num", U.money2(r.total)), actTd);
      tbody.append(tr);

      // Card (mobile)
      const item = el("div", "tx-item");
      const left = el("div");
      left.append(el("strong", "", r.customerName || "Walk-in"), el("div", "card-hint", r.invoiceNo + " · " + U.dateTime(r.createdAt)));
      const right = el("div");
      right.style.textAlign = "right";
      const bw = el("div"); bw.append(el("span", "badge" + (pay.cls ? " " + pay.cls : ""), pay.label));
      const vw = el("div"); vw.style.marginTop = ".3rem"; vw.append(viewButton(r));
      right.append(el("strong", "", U.money2(r.total)), bw, vw);
      item.append(left, right);
      list.append(item);
    });
    table.append(thead, tbody);
    tw.append(table);
    wrap.append(tw, list);
  }

  function renderDashboard() {
    renderMoneyCards();
    renderStockCards();
    renderRecent();
  }

  /* ---------- Online / offline indicator ---------- */
  function updateNet() {
    const on = navigator.onLine;
    const pill = $("netStatus");
    pill.classList.toggle("online", on);
    pill.classList.toggle("offline", !on);
    pill.querySelector(".status-text").textContent = on ? "Online" : "Offline";
  }

  /* ---------- Init ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    buildNav();
    renderDashboard();
    updateNet();
    window.addEventListener("online", updateNet);
    window.addEventListener("offline", updateNet);
    $("menuBtn").addEventListener("click", () => toggleMenu(!$("sidebar").classList.contains("open")));
    $("scrim").addEventListener("click", () => toggleMenu(false));
    $("settingsBtn").addEventListener("click", () => go("settings"));
    document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => {
      go(b.dataset.go);
      if (b.dataset.action === "add-product" && window.DukaanProducts) window.DukaanProducts.openAdd();
      if (b.dataset.action === "add-expense" && window.DukaanExpenses) window.DukaanExpenses.openAdd();
    }));
    // The dashboard follows the saved data.
    document.addEventListener("products-changed", renderDashboard);
    document.addEventListener("sales-changed", renderDashboard);
    document.addEventListener("ledger-changed", renderDashboard);
    document.addEventListener("expenses-changed", renderDashboard);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") toggleMenu(false); });
    window.addEventListener("hashchange", () => go(location.hash.slice(1)));
    go(location.hash.slice(1) || "dashboard");
  });
})();
