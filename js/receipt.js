/*
 * receipt.js - Phase 3: builds the receipt / invoice and prints it with the
 * browser's own print dialog.
 *
 *   compact : narrow slip (about 72 mm wide) for receipt printers
 *   a4      : full-page invoice
 *
 * Printer note: the app cannot talk to a thermal printer directly. The
 * printer must be installed on the device and chosen in the print dialog.
 * Paper size, margins and cutting depend on the printer and its driver.
 */
(function () {
  "use strict";

  const U = window.DukaanUtil;
  const el = U.el;

  function row(left, right, cls) {
    const d = el("div", "rw" + (cls ? " " + cls : ""));
    d.append(el("span", "", left), el("span", "", right));
    return d;
  }

  function discountLabel(sale) {
    return "Discount" + (sale.discountType === "percent" && sale.discountValue > 0 ? " (" + sale.discountValue + "%)" : "");
  }

  function paymentRows(sale, parent) {
    sale.payments.forEach((p) => parent.append(row(U.METHODS[p.method] || p.method, U.money2(p.amount))));
    parent.append(row("Total paid", U.money2(sale.amountPaid), "b"));
    if (sale.outstanding > 0) parent.append(row("Balance due (credit)", U.money2(sale.outstanding), "b"));
  }

  function buildCompact(sale, shop) {
    const r = el("div", "receipt compact");
    r.append(el("div", "c b big", shop.name || "Your Shop"));
    if (shop.address) r.append(el("div", "c", shop.address));
    if (shop.phone) r.append(el("div", "c", "Phone: " + shop.phone));
    r.append(el("div", "hr"));
    r.append(row("Invoice", sale.invoiceNo), row("Date", U.dateTime(sale.createdAt)));
    if (sale.customerName) r.append(row("Customer", sale.customerName));
    if (sale.status === "cancelled") r.append(el("div", "stamp", "CANCELLED"));
    r.append(el("div", "hr"));
    sale.items.forEach((it) => {
      r.append(el("div", "item-name", it.name));
      r.append(row(U.qty(it.qty, it.unit) + " x " + U.money2(it.unitPrice), U.money2(it.lineTotal)));
    });
    r.append(el("div", "hr"));
    r.append(row("Subtotal", U.money2(sale.subtotal)));
    if (sale.discount > 0) r.append(row(discountLabel(sale), "- " + U.money2(sale.discount)));
    if (sale.tax > 0) r.append(row("Tax (" + sale.taxRate + "%)", U.money2(sale.tax)));
    r.append(row("TOTAL", U.money2(sale.total), "b big"));
    r.append(el("div", "hr"));
    paymentRows(sale, r);
    r.append(el("div", "hr"));
    r.append(el("div", "c", (shop.footer || "Thank you! Visit again.")));
    return r;
  }

  function buildA4(sale, shop) {
    const r = el("div", "receipt a4");
    const head = el("div", "a4-head");
    const left = el("div");
    left.append(el("h2", "a4-shop", shop.name || "Your Shop"));
    if (shop.address) left.append(el("div", "", shop.address));
    if (shop.phone) left.append(el("div", "", "Phone: " + shop.phone));
    const right = el("div", "a4-meta");
    right.append(el("div", "a4-title", "INVOICE"), el("div", "", "Invoice no: " + sale.invoiceNo), el("div", "", "Date: " + U.dateTime(sale.createdAt)));
    if (sale.customerName) right.append(el("div", "", "Customer: " + sale.customerName));
    if (sale.customerPhone) right.append(el("div", "", "Phone: " + sale.customerPhone));
    head.append(left, right);
    r.append(head);
    if (sale.status === "cancelled") r.append(el("div", "stamp", "CANCELLED"));

    const table = el("table", "a4-table");
    const thead = el("thead"), hr = el("tr");
    ["#", "Item", "Qty", "Unit price", "Amount"].forEach((h, i) => {
      const th = el("th", i >= 2 ? "num" : "", h); th.scope = "col"; hr.append(th);
    });
    thead.append(hr);
    const tbody = el("tbody");
    sale.items.forEach((it, i) => {
      const tr = el("tr");
      tr.append(el("td", "", String(i + 1)), el("td", "", it.name), el("td", "num", U.qty(it.qty, it.unit)),
        el("td", "num", U.money2(it.unitPrice)), el("td", "num", U.money2(it.lineTotal)));
      tbody.append(tr);
    });
    table.append(thead, tbody);
    r.append(table);

    const totals = el("div", "a4-totals");
    totals.append(row("Subtotal", U.money2(sale.subtotal)));
    if (sale.discount > 0) totals.append(row(discountLabel(sale), "- " + U.money2(sale.discount)));
    if (sale.tax > 0) totals.append(row("Tax (" + sale.taxRate + "%)", U.money2(sale.tax)));
    totals.append(row("TOTAL", U.money2(sale.total), "b big"));
    r.append(totals);

    const pay = el("div", "a4-pay");
    pay.append(el("div", "b", "Payment"));
    paymentRows(sale, pay);
    r.append(pay);

    r.append(el("div", "c a4-foot", shop.footer || "Thank you! Visit again."));
    r.append(el("div", "c a4-note", "Computer-generated bill. It is not a statutory GST tax invoice. UPI, card and bank entries are payments recorded by the shop."));
    return r;
  }

  function build(sale, mode) {
    const shop = window.DukaanSettings ? window.DukaanSettings.get() : {};
    return mode === "a4" ? buildA4(sale, shop) : buildCompact(sale, shop);
  }

  // Fill the hidden print area, set the paper size, then open the browser's print dialog.
  function print(sale, mode) {
    const area = U.$("printArea");
    area.replaceChildren(build(sale, mode));
    area.className = mode === "a4" ? "print-a4" : "print-compact";
    // A4 sets its paper size. The compact slip sets only a margin: the receipt is 72 mm wide and the
    // paper size is chosen in the print dialog (a roll size for a thermal printer, or A4 for a normal one).
    U.$("pageStyle").textContent = mode === "a4"
      ? "@page { size: A4; margin: 12mm; }"
      : "@page { margin: 3mm; }";
    const clean = () => { area.replaceChildren(); window.removeEventListener("afterprint", clean); };
    window.addEventListener("afterprint", clean);
    window.print();
  }

  window.DukaanReceipt = { build: build, print: print };
})();