/*
 * alerts.js - Phase 8: Stock Alerts page.
 * Shows products that are low on stock or out of stock, with search and filters, and the latest stock
 * movements. It does not keep its own stock numbers: it reads the product list that js/products.js
 * already keeps, and uses that file's rules (statusOf, thresholdOf), so the dashboard, the Products page
 * and this page always agree. Any sale, cancellation, adjustment or restore ends in the "products-changed"
 * event, and this page redraws on it. Stock itself is changed only by products.js and sales.js.
 */
(function () {
  "use strict";

  const U = window.DukaanUtil;
  const DB = window.DukaanDB;
  const $ = (id) => document.getElementById(id);
  const el = U.el;
  const MOVES_SHOWN = 30;
  const TYPE_LABEL = { opening: "Opening stock", sale: "Sale", "sale-cancel": "Sale cancelled", adjustment: "Adjustment" };

  const state = { moves: [], movesTotal: 0, movesError: "", movesLoading: false, seq: 0 };
  const products = () => window.DukaanProducts;

  function card(label, value, hint, accent) {
    const c = el("div", "card" + (accent ? " accent-" + accent : ""));
    c.append(el("div", "card-label", label), el("div", "card-value", value), el("div", "card-hint", hint));
    return c;
  }

  // Products that need attention, worst first: out of stock, then the lowest stock compared to its level.
  function alertRows() {
    const P = products();
    return P.list()
      .map((p) => ({ p: p, s: P.statusOf(p) }))
      .filter((r) => r.s === "low" || r.s === "out")
      .sort((a, b) => {
        if (a.s !== b.s) return a.s === "out" ? -1 : 1;
        const ga = a.p.stock - P.thresholdOf(a.p), gb = b.p.stock - P.thresholdOf(b.p);
        return ga - gb || a.p.name.localeCompare(b.p.name);
      });
  }

  function levelText(p) {
    const P = products();
    return U.qty(P.thresholdOf(p), p.unit) + (P.hasOwnThreshold(p) ? "" : " (default)");
  }

  function statusBadge(s) {
    return el("span", "badge " + (s === "out" ? "out" : "credit"), s === "out" ? "Out of stock" : "Low stock");
  }

  function actions(p) {
    const box = el("div", "p-actions");
    [["Adjust stock", "adjust", true], ["Edit alert level", "level", false]].forEach((a) => {
      const b = el("button", "btn btn-sm" + (a[2] ? " btn-primary" : ""), a[0]);
      b.type = "button";
      b.dataset.act = a[1];
      b.dataset.id = p.id;
      b.setAttribute("aria-label", a[0] + ": " + p.name);
      box.append(b);
    });
    return box;
  }

  function emptyBox(title, text, withButton) {
    const e = el("div", "empty-state");
    e.append(el("h2", "", title), el("p", "", text));
    if (withButton) {
      const b = el("button", "btn btn-primary", "Go to Products");
      b.type = "button";
      b.style.marginTop = ".8rem";
      b.addEventListener("click", () => { location.hash = "#products"; });
      e.append(b);
    }
    return e;
  }

  function refreshCategories(rows) {
    const sel = $("alCategory"), keep = sel.value;
    const cats = Array.from(new Set(rows.map((r) => r.p.category).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    sel.replaceChildren(new Option("All categories", ""));
    cats.forEach((c) => sel.append(new Option(c, c)));
    sel.value = cats.includes(keep) ? keep : "";
  }

  function render() {
    const P = products();
    const cards = $("alCards"), list = $("alList");
    cards.replaceChildren();
    list.replaceChildren();
    if (!P) return;
    $("alInfo").textContent = "Low stock: stock is above 0 but at or below the product’s alert level. Out of stock: stock is 0. "
      + "Set the alert level for each product when you add or edit it. A product with no level saved uses the default of " + P.DEFAULT_LOW_STOCK
      + " and is marked “default”. Archived products are never listed. This page updates by itself after sales, cancellations and stock adjustments.";

    const st = P.stats();
    if (st === null) {
      $("alError").hidden = true;
      cards.append(card("Low stock", "…", "Loading", "gold"), card("Out of stock", "…", "Loading", "warn"));
      $("alCount").textContent = "Loading stock levels…";
      return;
    }
    if (st.failed) {
      $("alError").textContent = "Stock data could not be read from this device, so alerts are unavailable until storage works.";
      $("alError").hidden = false;
      cards.append(card("Low stock", "–", "Storage unavailable", "warn"), card("Out of stock", "–", "Storage unavailable", "warn"));
      $("alCount").textContent = "";
      return;
    }
    $("alError").hidden = true;
    cards.append(
      card("Low stock", String(st.low), "Above 0, at or below the alert level", "gold"),
      card("Out of stock", String(st.out), "Stock is 0", "warn")
    );

    const all = alertRows();
    refreshCategories(all);
    const q = $("alSearch").value.trim().toLowerCase(), want = $("alStatus").value, cat = $("alCategory").value;
    const rows = all.filter((r) => {
      if (want !== "all" && r.s !== want) return false;
      if (cat && r.p.category !== cat) return false;
      if (q && ![r.p.name, r.p.sku, r.p.barcode].join(" ").toLowerCase().includes(q)) return false;
      return true;
    });

    $("alCount").textContent = all.length ? rows.length + (rows.length === 1 ? " alert" : " alerts") + " shown (of " + all.length + ")" : "";
    if (!P.list().length) { list.append(emptyBox("No products yet", "Add products first. Alerts appear here when stock runs low.", true)); return; }
    if (!all.length) { list.append(emptyBox("No stock alerts", "No active product is low or out of stock right now.", false)); return; }
    if (!rows.length) { list.append(emptyBox("No alerts match", "Try a different search or clear the filters.", false)); return; }

    const tw = el("div", "table-wrap");
    const table = el("table");
    table.append(el("caption", "sr-only", "Stock alerts"));
    const hr = el("tr");
    ["Product", "Current stock", "Alert level", "Status", "Actions"].forEach((h) => { const th = el("th", "", h); th.scope = "col"; hr.append(th); });
    const thead = el("thead"); thead.append(hr);
    const tbody = el("tbody");
    const cardsList = el("div", "tx-list");
    rows.forEach((r) => {
      const p = r.p;
      const name = el("td");
      name.append(el("strong", "", p.name));
      if (p.sku) name.append(el("div", "card-hint", "SKU: " + p.sku));
      const stat = el("td"); stat.append(statusBadge(r.s));
      const act = el("td"); act.append(actions(p));
      const tr = el("tr");
      tr.append(name, el("td", "", U.qty(p.stock, p.unit)), el("td", "", levelText(p)), stat, act);
      tbody.append(tr);

      const c = el("div", "p-card");
      const top = el("div", "p-card-top");
      const left = el("div");
      left.append(el("strong", "", p.name), el("div", "card-hint", [p.sku ? "SKU " + p.sku : "", p.category].filter(Boolean).join(" · ")));
      top.append(left, statusBadge(r.s));
      const mid = el("div", "p-card-mid");
      mid.append(el("span", "", "Stock: " + U.qty(p.stock, p.unit)), el("span", "card-hint", "Alert level: " + levelText(p)));
      c.append(top, mid, actions(p));
      cardsList.append(c);
    });
    table.append(thead, tbody);
    tw.append(table);
    list.append(tw, cardsList);
  }

  /* ----- recent stock movements (read from the stock history the app already keeps) ----- */
  function refText(h) {
    if (h.ref) return h.ref;
    if ((h.type === "sale" || h.type === "sale-cancel") && h.reason) return String(h.reason).split(" ").pop();
    return "–";
  }

  function renderMoves() {
    const body = $("alMovesBody");
    body.replaceChildren();
    if (state.movesLoading) { body.append(el("p", "muted", "Loading movements…")); return; }
    if (state.movesError) { body.append(el("p", "alert", state.movesError)); return; }
    if (!state.moves.length) { body.append(el("p", "muted", "No stock movements recorded yet.")); return; }
    const units = {};
    products().list().forEach((p) => { units[p.id] = p.unit; });
    const tw = el("div", "table-wrap always");
    const table = el("table", "ledger");
    table.append(el("caption", "sr-only", "Recent stock movements"));
    const hr = el("tr");
    ["Date", "Product", "Type", "Change", "Stock after", "Reason / note", "Reference"].forEach((h) => { const th = el("th", "", h); th.scope = "col"; hr.append(th); });
    const thead = el("thead"); thead.append(hr);
    const tbody = el("tbody");
    state.moves.forEach((h) => {
      const unit = units[h.productId] || "";
      const sign = h.change >= 0 ? "+" : "−";
      const tr = el("tr");
      tr.append(
        el("td", "", U.dateTime(h.createdAt)), el("td", "", h.productName || "–"), el("td", "", TYPE_LABEL[h.type] || h.type || "–"),
        el("td", "", sign + U.qty(Math.abs(h.change), unit).trim()), el("td", "", U.qty(h.after, unit).trim()),
        el("td", "", (h.reason || "") + (h.note ? " – " + h.note : "")), el("td", "", refText(h))
      );
      tbody.append(tr);
    });
    table.append(thead, tbody);
    tw.append(table);
    body.append(tw, el("p", "card-hint", "Showing the latest " + state.moves.length + " of " + state.movesTotal + " movements. Open a product to see all of its history."));
  }

  async function loadMoves() {
    const seq = ++state.seq;
    state.movesLoading = true;
    renderMoves();
    try {
      const rows = await DB.run(["stockHistory"], "readonly", (tx) => DB.req(tx.objectStore("stockHistory").getAll()));
      if (seq !== state.seq) return; // a newer load is running
      rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      state.movesTotal = rows.length;
      state.moves = rows.slice(0, MOVES_SHOWN);
      state.movesError = "";
    } catch (e) {
      if (seq !== state.seq) return;
      state.movesError = e.message + " Movements could not be loaded.";
    }
    state.movesLoading = false;
    renderMoves();
  }

  function onListClick(e) {
    const b = e.target.closest("button[data-act]");
    if (!b || !products()) return;
    if (b.dataset.act === "adjust") products().openAdjust(b.dataset.id);
    if (b.dataset.act === "level") products().openEdit(b.dataset.id, "fLow");
  }

  function init() {
    $("alList").addEventListener("click", onListClick);
    $("alSearch").addEventListener("input", render);
    $("alStatus").addEventListener("change", render);
    $("alCategory").addEventListener("change", render);
    $("alMoves").addEventListener("toggle", () => { if ($("alMoves").open) loadMoves(); });
    // Sales, cancellations, adjustments, edits, archive/restore and restore-from-backup all end here.
    document.addEventListener("products-changed", () => {
      render();
      if ($("alMoves").open) loadMoves();
    });
    render();
  }

  window.DukaanAlerts = { render: render, loadMoves: loadMoves, rows: () => alertRows().map((r) => ({ id: r.p.id, name: r.p.name, stock: r.p.stock, level: products().thresholdOf(r.p), status: r.s })) };
  document.addEventListener("DOMContentLoaded", init);
})();
