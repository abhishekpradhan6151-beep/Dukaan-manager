/* Dukaan Manager - Phase 1 (UI shell). No storage or transaction logic yet. */
(function () {
  "use strict";

  const PAGES = [
    { id: "dashboard", label: "Dashboard", icon: "\u2302" },
    { id: "sale", label: "New Sale", icon: "\u271A" },
    { id: "products", label: "Products", icon: "\u25A6" },
    { id: "sales", label: "Sales History", icon: "\u2630" },
    { id: "customers", label: "Customers & Udhaar", icon: "\u263A" },
    { id: "expenses", label: "Expenses", icon: "\u20B9" },
    { id: "reports", label: "Reports", icon: "\u2211" },
    { id: "settings", label: "Settings & Backup", icon: "\u2699" }
  ];
  const BOTTOM = [
    { id: "dashboard", label: "Home" },
    { id: "sale", label: "Sale" },
    { id: "products", label: "Products" },
    { id: "customers", label: "Udhaar" }
  ];

  const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
  const fmt = (n) => inr.format(n);

  const $ = (id) => document.getElementById(id);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text; // textContent keeps rendering safe
    return e;
  }

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
    const i = el("span", "nav-ico", "\u22EF");
    i.setAttribute("aria-hidden", "true");
    more.append(i, el("span", "nav-text", "More"));
    more.addEventListener("click", () => toggleMenu(true));
    li.append(more);
    $("bottomNav").append(li);
  }

  function go(page) {
    if (!PAGES.some((p) => p.id === page)) page = "dashboard";
    PAGES.forEach((p) => { $("view-" + p.id).hidden = p.id !== page; });
    document.querySelectorAll(".nav-link[data-page]").forEach((b) => {
      if (b.dataset.page === page) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    const title = PAGES.find((p) => p.id === page).label;
    document.title = title + " \u2013 Dukaan Manager";
    if (location.hash !== "#" + page) history.replaceState(null, "", "#" + page);
    toggleMenu(false);
    window.scrollTo(0, 0);
    $("main").focus();
  }

  function toggleMenu(open) {
    $("sidebar").classList.toggle("open", open);
    $("scrim").hidden = !open;
    $("menuBtn").setAttribute("aria-expanded", String(open));
  }

  /* ---------- Dashboard (from DEMO data) ---------- */
  function card(label, value, hint, accent) {
    const c = el("div", "card" + (accent ? " accent-" + accent : ""));
    c.append(el("div", "card-label", label), el("div", "card-value", value), el("div", "card-hint", hint));
    return c;
  }

  function renderDashboard() {
    const t = DEMO.today, s = DEMO.stock;
    $("cardsMoney").append(
      card("Total sales", fmt(t.sales), "Value of bills made (revenue)"),
      card("Cash received", fmt(t.cash), "Cash actually collected", "teal"),
      card("UPI recorded", fmt(t.upi), "Record only, not verified", "teal"),
      card("Credit sales", fmt(t.credit), "Not yet paid (udhaar)", "gold"),
      card("Expenses", fmt(t.expenses), "Money spent today", "gold"),
      card("Est. gross profit", fmt(t.grossProfit), "Estimate, before expenses")
    );
    $("cardsStock").append(
      card("Total products", String(s.totalProducts), "Active items"),
      card("Low stock", String(s.lowStock), "Items needing restock", "warn"),
      card("Customer credit due", fmt(s.outstandingCredit), "Total outstanding udhaar", "gold")
    );

    const rows = DEMO.recent;
    if (!rows.length) {
      const e = el("div", "empty-state");
      e.append(el("h2", "", "No transactions yet"), el("p", "", "Completed sales will appear here."));
      $("recentWrap").append(e);
      return;
    }
    // Table (tablet/desktop)
    const wrap = el("div", "table-wrap");
    const table = el("table");
    const cap = el("caption", "sr-only", "Recent demo transactions");
    const thead = el("thead");
    const hr = el("tr");
    ["Invoice", "Time", "Customer", "Payment", "Amount"].forEach((h, i) => {
      const th = el("th", i === 4 ? "num" : "", h);
      th.scope = "col";
      hr.append(th);
    });
    thead.append(hr);
    const tbody = el("tbody");
    const list = el("div", "tx-list");
    rows.forEach((r) => {
      const credit = r.method === "Udhaar";
      const tr = el("tr");
      const badgeTd = el("td");
      badgeTd.append(el("span", "badge" + (credit ? " credit" : ""), r.method));
      tr.append(el("td", "", r.invoice), el("td", "", r.time), el("td", "", r.customer), badgeTd, el("td", "num", fmt(r.amount)));
      tbody.append(tr);
      // Card (mobile)
      const item = el("div", "tx-item");
      const left = el("div");
      left.append(el("strong", "", r.customer), el("div", "card-hint", r.invoice + " \u00B7 " + r.time));
      const right = el("div");
      right.style.textAlign = "right";
      right.append(el("strong", "", fmt(r.amount)), el("div"));
      right.lastChild.append(el("span", "badge" + (credit ? " credit" : ""), r.method));
      item.append(left, right);
      list.append(item);
    });
    table.append(cap, thead, tbody);
    wrap.append(table);
    $("recentWrap").append(wrap, list);
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
    $("shopName").textContent = DEMO.shopName;
    buildNav();
    renderDashboard();
    updateNet();
    window.addEventListener("online", updateNet);
    window.addEventListener("offline", updateNet);
    $("menuBtn").addEventListener("click", () => toggleMenu(!$("sidebar").classList.contains("open")));
    $("scrim").addEventListener("click", () => toggleMenu(false));
    $("settingsBtn").addEventListener("click", () => go("settings"));
    document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") toggleMenu(false); });
    window.addEventListener("hashchange", () => go(location.hash.slice(1)));
    go(location.hash.slice(1) || "dashboard");
  });
})();