/*
 * products.js - Phase 2: product and inventory management.
 * Business rules live in the "data" section. The UI section only reads the
 * screen and calls those functions. Stock changes ONLY through createProduct
 * (opening stock) and adjustStock, and each one writes a stock-history entry.
 */
(function () {
  "use strict";

  const DB = window.DukaanDB;
  const PAGE_SIZE = 50;
  const DEFAULT_LOW_STOCK = 5;

  const UNITS = [
    { id: "piece", label: "Piece", decimal: false },
    { id: "packet", label: "Packet", decimal: false },
    { id: "box", label: "Box", decimal: false },
    { id: "dozen", label: "Dozen", decimal: false },
    { id: "kg", label: "Kilogram (kg)", decimal: true },
    { id: "g", label: "Gram (g)", decimal: true },
    { id: "litre", label: "Litre", decimal: true },
    { id: "ml", label: "Millilitre (ml)", decimal: true },
    { id: "metre", label: "Metre", decimal: true }
  ];
  const CATEGORY_SUGGESTIONS = ["General", "Grocery", "Clothing", "Stationery", "Electronics", "Hardware", "Gifts", "Other"];
  const ADD_REASONS = ["Stock received (purchase)", "Customer return", "Count correction", "Other"];
  const REMOVE_REASONS = ["Damaged", "Expired", "Lost or stolen", "Used in shop", "Count correction", "Other"];

  const state = { products: [], shown: PAGE_SIZE, saving: false, loaded: false, failed: false, editingId: null, adjustId: null, detailId: null };

  const $ = (id) => document.getElementById(id);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text; // textContent keeps rendering safe
    return e;
  }
  const unitInfo = (u) => UNITS.find((x) => x.id === u) || UNITS[0];
  const round = (n, d) => { const f = Math.pow(10, d); return Math.round((n + Number.EPSILON) * f) / f; };
  const qtyFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });
  const moneyFmt = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const dateFmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
  const fmtDate = (iso) => { try { return dateFmt.format(new Date(iso)); } catch (_) { return iso; } };
  const fmtQty = (n, unit) => qtyFmt.format(n) + " " + unit;

  /* =====================  DATA / BUSINESS RULES  ===================== */

  // Strict number parsing: digits with optional decimals. No commas, no "1e3".
  function parseMoney(s) { s = String(s).trim(); return /^\d{1,9}(\.\d{1,2})?$/.test(s) ? Number(s) : NaN; }
  function parseQty(s) { s = String(s).trim(); return /^\d{1,7}(\.\d{1,3})?$/.test(s) ? Number(s) : NaN; }

  const isLow = (p) => p.status === "active" && p.stock <= p.lowStockThreshold;

  function stockState(p) {
    if (p.stock <= 0) return { label: "Out of stock", cls: "out" };
    if (p.stock <= p.lowStockThreshold) return { label: "Low stock", cls: "credit" };
    return { label: "In stock", cls: "" };
  }

  function historyEntry(p, before, after, reason, note, type) {
    return {
      id: DB.uid(), productId: p.id, productName: p.name, type: type,
      change: round(after - before, 3), before: before, after: after,
      reason: reason, note: note || "", createdAt: DB.now()
    };
  }

  function loadProducts() {
    return DB.run(["products"], "readonly", (tx) => DB.req(tx.objectStore("products").getAll()));
  }

  // New product + opening-stock history entry are saved in ONE transaction.
  function createProduct(p, openingStock) {
    return DB.run(["products", "stockHistory"], "readwrite", (tx) => {
      tx.objectStore("products").add(p); // add() fails on a duplicate ID
      if (openingStock > 0) {
        tx.objectStore("stockHistory").add(historyEntry(p, 0, openingStock, "Opening stock", "", "opening"));
      }
    });
  }

  // Editing details NEVER touches stock. Only these fields can change.
  function updateProduct(id, f) {
    return DB.run(["products"], "readwrite", async (tx) => {
      const store = tx.objectStore("products");
      const cur = await DB.req(store.get(id));
      if (!cur) throw new Error("Product not found. It may have been removed.");
      cur.name = f.name; cur.sku = f.sku; cur.barcode = f.barcode; cur.category = f.category;
      cur.unit = f.unit; cur.cost = f.cost; cur.price = f.price;
      cur.lowStockThreshold = f.lowStockThreshold; cur.description = f.description;
      cur.updatedAt = DB.now();
      store.put(cur);
    });
  }

  // signedQty is positive to add stock, negative to remove it.
  function adjustStock(id, signedQty, reason, note) {
    return DB.run(["products", "stockHistory"], "readwrite", async (tx) => {
      const store = tx.objectStore("products");
      const cur = await DB.req(store.get(id));
      if (!cur) throw new Error("Product not found. It may have been removed.");
      if (cur.status !== "active") throw new Error("Archived products cannot be adjusted. Restore the product first.");
      const before = cur.stock;
      const after = round(before + signedQty, 3);
      if (after < 0) throw new Error("Stock cannot go below zero. Current stock is " + fmtQty(before, cur.unit) + ".");
      cur.stock = after;
      cur.updatedAt = DB.now();
      store.put(cur);
      tx.objectStore("stockHistory").add(historyEntry(cur, before, after, reason, note, "adjustment"));
    });
  }

  function setStatus(id, status) {
    return DB.run(["products"], "readwrite", async (tx) => {
      const store = tx.objectStore("products");
      const cur = await DB.req(store.get(id));
      if (!cur) throw new Error("Product not found.");
      cur.status = status;
      cur.updatedAt = DB.now();
      store.put(cur);
    });
  }

  function loadHistory(productId) {
    return DB.run(["stockHistory"], "readonly", (tx) => DB.req(tx.objectStore("stockHistory").index("productId").getAll(productId)))
      .then((rows) => rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }

  function skuTaken(sku, exceptId) {
    if (!sku) return null;
    const s = sku.toLowerCase();
    return state.products.find((p) => p.id !== exceptId && p.sku && p.sku.toLowerCase() === s) || null;
  }

  // Validate raw form values. Returns { errs: {fieldId: message}, vals: parsed numbers }.
  function validateProduct(v, editing) {
    const errs = {};
    const info = unitInfo(v.unit);
    if (!v.name) errs.fName = "Enter a product name.";
    else if (v.name.length > 120) errs.fName = "Name is too long (max 120 characters).";
    if (v.sku.length > 40) errs.fSku = "SKU is too long (max 40 characters).";
    if (v.barcode.length > 64) errs.fBarcode = "Barcode is too long (max 64 characters).";
    if (v.category.length > 40) errs.fCategory = "Category is too long (max 40 characters).";
    if (v.description.length > 500) errs.fDesc = "Description is too long (max 500 characters).";

    const cost = parseMoney(v.cost);
    if (Number.isNaN(cost)) errs.fCost = "Enter a valid amount such as 45 or 45.50 (enter 0 if unknown).";
    const price = parseMoney(v.price);
    if (Number.isNaN(price)) errs.fPrice = "Enter a valid amount such as 60 or 59.90.";

    const low = parseQty(v.low);
    if (Number.isNaN(low)) errs.fLow = "Enter 0 or a positive number.";
    else if (!info.decimal && !Number.isInteger(low)) errs.fLow = "Use a whole number for this unit.";

    let opening = 0;
    if (editing) {
      if (!info.decimal && !Number.isInteger(editing.stock)) {
        errs.fUnit = "Current stock has decimals. Choose a unit that allows decimals, or adjust stock first.";
      }
    } else {
      opening = v.opening === "" ? 0 : parseQty(v.opening);
      if (Number.isNaN(opening)) errs.fOpening = "Enter 0 or a positive number such as 12 or 2.5.";
      else if (!info.decimal && !Number.isInteger(opening)) errs.fOpening = "This unit needs a whole number (no decimals).";
    }
    return { errs: errs, vals: { cost: cost, price: price, low: low, opening: opening } };
  }

  /* CSV: quote every cell, and neutralise spreadsheet formulas (= + - @). */
  function csvCell(val) {
    let s = val === null || val === undefined ? "" : String(val);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function toCsv() {
    const head = ["ID", "Name", "SKU", "Barcode", "Category", "Unit", "Purchase cost", "Selling price", "Stock", "Low-stock threshold", "Description", "Status", "Created", "Updated"];
    const rows = state.products.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) =>
      [p.id, p.name, p.sku, p.barcode, p.category, p.unit, p.cost, p.price, p.stock, p.lowStockThreshold, p.description, p.status, p.createdAt, p.updatedAt]);
    return [head].concat(rows).map((r) => r.map(csvCell).join(",")).join("\r\n");
  }

  /* =====================  UI  ===================== */

  let toastTimer = null;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  function showBanner(id, msg) {
    const b = $(id);
    b.textContent = msg || "";
    b.hidden = !msg;
  }

  function clearErrors(form) {
    form.querySelectorAll(".err").forEach((s) => { s.textContent = ""; });
    form.querySelectorAll("[aria-invalid]").forEach((i) => { i.removeAttribute("aria-invalid"); i.removeAttribute("aria-describedby"); });
  }
  function showErrors(errs) {
    Object.keys(errs).forEach((id) => {
      const input = $(id), span = $("e-" + id);
      if (span) span.textContent = errs[id];
      if (input) { input.setAttribute("aria-invalid", "true"); if (span) input.setAttribute("aria-describedby", "e-" + id); }
    });
    const first = Object.keys(errs)[0];
    if (first && $(first)) $(first).focus();
  }

  function setBusy(btn, busy, idleText) {
    state.saving = busy;
    btn.disabled = busy;
    btn.textContent = busy ? "Saving…" : idleText;
  }

  /* ----- list ----- */
  function filtered() {
    const q = $("pSearch").value.trim().toLowerCase();
    const cat = $("pCategory").value, st = $("pStatus").value, low = $("pLow").checked;
    let list = state.products.filter((p) => {
      if (st !== "all" && p.status !== st) return false;
      if (cat && p.category !== cat) return false;
      if (low && !isLow(p)) return false;
      if (q && ![p.name, p.sku, p.barcode].join(" ").toLowerCase().includes(q)) return false;
      return true;
    });
    const sort = $("pSort").value;
    const by = {
      "name-asc": (a, b) => a.name.localeCompare(b.name),
      "name-desc": (a, b) => b.name.localeCompare(a.name),
      "stock-asc": (a, b) => a.stock - b.stock,
      "stock-desc": (a, b) => b.stock - a.stock,
      "price-asc": (a, b) => a.price - b.price,
      "price-desc": (a, b) => b.price - a.price,
      "updated-desc": (a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)
    };
    return list.sort(by[sort] || by["name-asc"]);
  }

  function refreshCategoryOptions() {
    const cats = Array.from(new Set(state.products.map((p) => p.category).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const sel = $("pCategory"), keep = sel.value;
    sel.replaceChildren(new Option("All categories", ""));
    cats.forEach((c) => sel.append(new Option(c, c)));
    sel.value = cats.includes(keep) ? keep : "";
    const dl = $("categoryList");
    dl.replaceChildren();
    Array.from(new Set(CATEGORY_SUGGESTIONS.concat(cats))).forEach((c) => { const o = document.createElement("option"); o.value = c; dl.append(o); });
  }

  function actionButton(label, act, p, primary) {
    const b = el("button", "btn btn-sm" + (primary ? " btn-primary" : ""), label);
    b.type = "button";
    b.dataset.act = act;
    b.dataset.id = p.id;
    b.setAttribute("aria-label", label + ": " + p.name);
    return b;
  }
  function actionsFor(p) {
    const box = el("div", "p-actions");
    box.append(actionButton("View", "view", p));
    if (p.status === "active") {
      box.append(actionButton("Adjust", "adjust", p), actionButton("Edit", "edit", p));
    } else {
      box.append(actionButton("Restore", "restore", p));
    }
    return box;
  }
  function stockBadge(p) {
    if (p.status !== "active") return el("span", "badge muted", "Archived");
    const s = stockState(p);
    return el("span", "badge" + (s.cls ? " " + s.cls : ""), s.label);
  }

  function renderList() {
    const wrap = $("pList");
    wrap.replaceChildren();
    $("pMore").hidden = true;

    if (state.failed) { $("pCount").textContent = ""; return; }
    if (!state.loaded) { $("pCount").textContent = "Loading products…"; return; }

    if (state.products.length === 0) {
      $("pCount").textContent = "";
      const e = el("div", "empty-state");
      e.append(el("h2", "", "No products yet"), el("p", "", "Add your first product to start tracking stock. Products are saved on this device."));
      const b = el("button", "btn btn-primary", "+ Add your first product");
      b.type = "button"; b.dataset.act = "add"; b.style.marginTop = ".8rem";
      e.append(b);
      wrap.append(e);
      return;
    }

    const list = filtered();
    $("pCount").textContent = list.length + (list.length === 1 ? " product" : " products") + " shown (of " + state.products.length + " saved)";
    if (list.length === 0) {
      const e = el("div", "empty-state");
      e.append(el("h2", "", "No products match"), el("p", "", "Try a different search or clear the filters."));
      wrap.append(e);
      return;
    }

    const page = list.slice(0, state.shown);
    const tw = el("div", "table-wrap");
    const table = el("table");
    table.append(el("caption", "sr-only", "Products"));
    const thead = el("thead"), hr = el("tr");
    ["Product", "Category", "Stock", "Price", "Cost", "Actions"].forEach((h, i) => {
      const th = el("th", i === 3 || i === 4 ? "num" : "", h); th.scope = "col"; hr.append(th);
    });
    thead.append(hr);
    const tbody = el("tbody");
    const cards = el("div", "tx-list");

    page.forEach((p) => {
      const tr = el("tr");
      const nameTd = el("td");
      nameTd.append(el("strong", "", p.name));
      if (p.sku) nameTd.append(el("div", "card-hint", "SKU: " + p.sku));
      const stockTd = el("td");
      stockTd.append(document.createTextNode(fmtQty(p.stock, p.unit) + " "), stockBadge(p));
      const actTd = el("td"); actTd.append(actionsFor(p));
      tr.append(nameTd, el("td", "", p.category), stockTd, el("td", "num", moneyFmt.format(p.price)), el("td", "num", moneyFmt.format(p.cost)), actTd);
      tbody.append(tr);

      const c = el("div", "p-card");
      const top = el("div", "p-card-top");
      const left = el("div");
      left.append(el("strong", "", p.name), el("div", "card-hint", [p.sku ? "SKU " + p.sku : "", p.category].filter(Boolean).join(" · ")));
      const right = el("div"); right.style.textAlign = "right";
      right.append(el("strong", "", moneyFmt.format(p.price)), el("div", "card-hint", "per " + p.unit));
      top.append(left, right);
      const mid = el("div", "p-card-mid");
      mid.append(el("span", "", fmtQty(p.stock, p.unit)), stockBadge(p));
      c.append(top, mid, actionsFor(p));
      cards.append(c);
    });

    table.append(thead, tbody);
    tw.append(table);
    wrap.append(tw, cards);
    $("pMore").hidden = list.length <= state.shown;
  }

  async function refresh() {
    try {
      state.products = await loadProducts();
      state.loaded = true;
      state.failed = false;
      showBanner("pError", "");
    } catch (e) {
      state.failed = true;
      state.loaded = false;
      showBanner("pError", e.message + " Product features are turned off until storage works.");
    }
    $("pAdd").disabled = state.failed;
    refreshCategoryOptions();
    renderList();
    document.dispatchEvent(new CustomEvent("products-changed"));
  }

  /* ----- add / edit dialog ----- */
  function fillUnits() {
    const sel = $("fUnit");
    UNITS.forEach((u) => sel.append(new Option(u.label, u.id)));
  }

  function openForm(p) {
    const form = $("productForm");
    form.reset();
    clearErrors(form);
    showBanner("pdError", "");
    state.editingId = p ? p.id : null;
    $("pdTitle").textContent = p ? "Edit product" : "Add product";
    $("pdSave").textContent = p ? "Save changes" : "Save product";
    $("gOpening").hidden = !!p;
    $("stockNote").hidden = !p;
    if (p) {
      $("fName").value = p.name; $("fSku").value = p.sku; $("fBarcode").value = p.barcode;
      $("fCategory").value = p.category; $("fUnit").value = p.unit;
      $("fCost").value = p.cost; $("fPrice").value = p.price; $("fLow").value = p.lowStockThreshold;
      $("fDesc").value = p.description;
      $("stockNote").textContent = "Current stock: " + fmtQty(p.stock, p.unit) + ". Editing details never changes stock. Use “Adjust stock” to change it, so the change is recorded.";
    } else {
      $("fUnit").value = "piece"; $("fLow").value = String(DEFAULT_LOW_STOCK); $("fOpening").value = "0";
    }
    $("productDialog").showModal();
    $("fName").focus();
  }

  async function onProductSubmit(e) {
    e.preventDefault();
    if (state.saving) return; // blocks double-clicks
    const form = $("productForm");
    const editing = state.editingId ? state.products.find((p) => p.id === state.editingId) : null;
    if (state.editingId && !editing) { showBanner("pdError", "This product no longer exists."); return; }
    const v = {
      name: $("fName").value.trim(), sku: $("fSku").value.trim(), barcode: $("fBarcode").value.trim(),
      category: $("fCategory").value.trim(), unit: $("fUnit").value, cost: $("fCost").value, price: $("fPrice").value,
      opening: $("fOpening").value, low: $("fLow").value, description: $("fDesc").value.trim()
    };
    clearErrors(form);
    showBanner("pdError", "");
    const res = validateProduct(v, editing);
    if (Object.keys(res.errs).length) { showErrors(res.errs); return; }

    const dup = skuTaken(v.sku, state.editingId);
    if (dup && !window.confirm("Another product (“" + dup.name + "”) already uses the SKU “" + v.sku + "”. Save anyway?")) return;
    if (res.vals.price < res.vals.cost && !window.confirm("The selling price (" + moneyFmt.format(res.vals.price) + ") is lower than the purchase cost (" + moneyFmt.format(res.vals.cost) + "). Save anyway?")) return;

    const fields = {
      name: v.name, sku: v.sku, barcode: v.barcode, category: v.category || "General", unit: v.unit,
      cost: res.vals.cost, price: res.vals.price, lowStockThreshold: res.vals.low, description: v.description
    };
    const idle = state.editingId ? "Save changes" : "Save product";
    setBusy($("pdSave"), true, idle);
    try {
      if (state.editingId) {
        await updateProduct(state.editingId, fields);
      } else {
        const now = DB.now();
        const p = Object.assign({ id: DB.uid(), stock: res.vals.opening, status: "active", createdAt: now, updatedAt: now }, fields);
        await createProduct(p, res.vals.opening);
      }
      $("productDialog").close();
      toast(state.editingId ? "Changes saved." : "Product saved on this device.");
      await refresh();
    } catch (err) {
      showBanner("pdError", err.message);
    } finally {
      setBusy($("pdSave"), false, idle);
    }
  }

  /* ----- adjust stock dialog ----- */
  function fillReasons() {
    const list = $("aDir").value === "add" ? ADD_REASONS : REMOVE_REASONS;
    const sel = $("aReason");
    sel.replaceChildren(new Option("Choose a reason…", ""));
    list.forEach((r) => sel.append(new Option(r, r)));
  }
  function updatePreview() {
    const p = state.products.find((x) => x.id === state.adjustId);
    if (!p) return;
    const q = parseQty($("aQty").value);
    const out = $("adPreview");
    if (Number.isNaN(q)) { out.textContent = ""; return; }
    const after = round(p.stock + ($("aDir").value === "add" ? q : -q), 3);
    out.textContent = after < 0 ? "This would take stock below zero." : "Stock after this change: " + fmtQty(after, p.unit);
  }
  function openAdjust(p) {
    const form = $("adjustForm");
    form.reset();
    clearErrors(form);
    showBanner("adError", "");
    state.adjustId = p.id;
    $("adTitle").textContent = "Adjust stock: " + p.name;
    $("adCurrent").textContent = "Current stock: " + fmtQty(p.stock, p.unit);
    $("adPreview").textContent = "";
    fillReasons();
    $("adjustDialog").showModal();
    $("aQty").focus();
  }
  async function onAdjustSubmit(e) {
    e.preventDefault();
    if (state.saving) return;
    const p = state.products.find((x) => x.id === state.adjustId);
    if (!p) { showBanner("adError", "This product no longer exists."); return; }
    const form = $("adjustForm");
    clearErrors(form);
    showBanner("adError", "");
    const errs = {};
    const dir = $("aDir").value, reason = $("aReason").value, note = $("aNote").value.trim();
    const q = parseQty($("aQty").value);
    const info = unitInfo(p.unit);
    if (Number.isNaN(q) || q <= 0) errs.aQty = "Enter a quantity greater than 0.";
    else if (!info.decimal && !Number.isInteger(q)) errs.aQty = "This product is counted in whole numbers.";
    else if (dir === "remove" && q > p.stock) errs.aQty = "You only have " + fmtQty(p.stock, p.unit) + ". Stock cannot go below zero.";
    if (!reason) errs.aReason = "Choose a reason.";
    if (reason === "Other" && !note) errs.aNote = "Add a short note when the reason is “Other”.";
    if (Object.keys(errs).length) { showErrors(errs); return; }

    setBusy($("adSave"), true, "Save adjustment");
    try {
      await adjustStock(p.id, dir === "add" ? q : -q, reason, note);
      $("adjustDialog").close();
      toast("Stock updated and recorded in history.");
      await refresh();
      if (state.detailId === p.id) openDetail(p.id);
    } catch (err) {
      showBanner("adError", err.message);
    } finally {
      setBusy($("adSave"), false, "Save adjustment");
    }
  }

  /* ----- detail dialog ----- */
  async function openDetail(id) {
    const p = state.products.find((x) => x.id === id);
    if (!p) return;
    state.detailId = id;
    $("dtTitle").textContent = p.name;
    const badges = $("dtBadges");
    badges.replaceChildren(stockBadge(p));
    const dl = $("dtInfo");
    dl.replaceChildren();
    const rows = [
      ["Stock", fmtQty(p.stock, p.unit)],
      ["Low-stock alert at", fmtQty(p.lowStockThreshold, p.unit)],
      ["Selling price", moneyFmt.format(p.price) + " per " + p.unit],
      ["Purchase cost", moneyFmt.format(p.cost) + " per " + p.unit],
      ["Category", p.category],
      ["SKU", p.sku || "–"],
      ["Barcode", p.barcode || "–"],
      ["Description", p.description || "–"],
      ["Added", fmtDate(p.createdAt)],
      ["Last changed", fmtDate(p.updatedAt)],
      ["Product ID", p.id]
    ];
    rows.forEach((r) => { dl.append(el("dt", "", r[0]), el("dd", "", r[1])); });

    $("dtAdjust").hidden = p.status !== "active";
    $("dtEdit").hidden = p.status !== "active";
    $("dtArchive").textContent = p.status === "active" ? "Archive" : "Restore";

    const hist = $("dtHistory");
    hist.replaceChildren(el("p", "muted", "Loading history…"));
    if (!$("detailDialog").open) $("detailDialog").showModal();
    try {
      const rowsH = await loadHistory(id);
      if (state.detailId !== id) return;
      hist.replaceChildren();
      if (!rowsH.length) { hist.append(el("p", "muted", "No stock changes recorded yet.")); return; }
      const ul = el("ul", "hist");
      rowsH.forEach((h) => {
        const li = el("li");
        const sign = h.change >= 0 ? "+" : "−";
        li.append(el("strong", "", sign + qtyFmt.format(Math.abs(h.change)) + " " + p.unit + " → " + qtyFmt.format(h.after)));
        li.append(el("div", "", h.reason + (h.note ? " – " + h.note : "")));
        li.append(el("div", "card-hint", fmtDate(h.createdAt)));
        ul.append(li);
      });
      hist.append(ul);
    } catch (err) {
      hist.replaceChildren(el("p", "alert", err.message));
    }
  }

  async function toggleArchive(id) {
    const p = state.products.find((x) => x.id === id);
    if (!p) return;
    const archiving = p.status === "active";
    if (archiving && !window.confirm("Archive “" + p.name + "”? It will be hidden from the active list and cannot be sold. Its history is kept and you can restore it later.")) return;
    try {
      await setStatus(id, archiving ? "archived" : "active");
      toast(archiving ? "Product archived." : "Product restored.");
      if ($("detailDialog").open) $("detailDialog").close();
      await refresh();
    } catch (err) {
      showBanner("pError", err.message);
    }
  }

  /* ----- CSV download ----- */
  function exportCsv() {
    if (!state.products.length) { toast("No products to export yet."); return; }
    const blob = new Blob(["﻿" + toCsv()], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "dukaan-products-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ----- wiring ----- */
  function onListClick(e) {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const id = b.dataset.id;
    const p = state.products.find((x) => x.id === id);
    switch (b.dataset.act) {
      case "add": openForm(null); break;
      case "view": openDetail(id); break;
      case "edit": if (p) openForm(p); break;
      case "adjust": if (p) openAdjust(p); break;
      case "restore": toggleArchive(id); break;
    }
  }

  function resetPaging() { state.shown = PAGE_SIZE; renderList(); }

  function init() {
    fillUnits();
    $("pAdd").addEventListener("click", () => openForm(null));
    $("pExport").addEventListener("click", exportCsv);
    $("pList").addEventListener("click", onListClick);
    ["pSearch", "pCategory", "pStatus", "pSort", "pLow"].forEach((id) => {
      $(id).addEventListener(id === "pSearch" ? "input" : "change", resetPaging);
    });
    $("pMore").addEventListener("click", () => { state.shown += PAGE_SIZE; renderList(); });

    $("productForm").addEventListener("submit", onProductSubmit);
    $("pdCancel").addEventListener("click", () => $("productDialog").close());
    $("adjustForm").addEventListener("submit", onAdjustSubmit);
    $("adCancel").addEventListener("click", () => $("adjustDialog").close());
    $("aDir").addEventListener("change", () => { fillReasons(); updatePreview(); });
    $("aQty").addEventListener("input", updatePreview);

    $("dtClose").addEventListener("click", () => $("detailDialog").close());
    $("detailDialog").addEventListener("close", () => { state.detailId = null; });
    $("dtEdit").addEventListener("click", () => {
      const p = state.products.find((x) => x.id === state.detailId);
      $("detailDialog").close();
      if (p) openForm(p);
    });
    $("dtAdjust").addEventListener("click", () => {
      const p = state.products.find((x) => x.id === state.detailId);
      if (p) openAdjust(p); // detail dialog stays open underneath and refreshes after saving
    });
    $("dtArchive").addEventListener("click", () => toggleArchive(state.detailId));

    refresh();
  }

  window.DukaanProducts = {
    openAdd: () => { if (!state.failed) openForm(null); },
    stats: () => {
      if (state.failed) return { failed: true };
      if (!state.loaded) return null;
      const active = state.products.filter((p) => p.status === "active");
      return { total: active.length, low: active.filter(isLow).length };
    },
    toCsv: toCsv,
    _validate: validateProduct
  };

  document.addEventListener("DOMContentLoaded", init);
})();
