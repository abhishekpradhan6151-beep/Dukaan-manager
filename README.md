# Dukaan Manager (Phase 3: Billing, Sales History, Receipts)

Offline-first shop management app for Indian shopkeepers. Plain HTML, CSS and JavaScript, no build step.

## Status
- **Phase 1** done: responsive layout, navigation, dashboard.
- **Phase 2** done: products and inventory (IndexedDB).
- **Phase 3** done: billing, sales history, receipt and invoice printing, shop details for receipts.
- Everything shown is real data saved on this device. There is no sample data any more.

## Run it
Serve the folder (browser storage is most reliable on http://localhost):

    cd dukaan-manager
    python3 -m http.server 8000

then open http://localhost:8000. Opening `index.html` directly may work, but some browsers restrict storage for `file://` pages.

## Using Phase 3
1. **Settings > Shop details**: enter shop name, address, phone, invoice prefix and receipt footer (printed on bills).
2. **Products**: add products with stock (Phase 2).
3. **New Sale**: search (or scan a barcode and press Enter), tap Add, change quantities, optionally add a discount (amount or %) and a tax % for that bill, choose how it was paid, then **Complete sale**.
   - Payment starts as "Cash, paid in full". Use UPI, "All on credit (udhaar)", or "+ Part / split payment" for several methods or part payment.
   - Whatever is not paid now becomes credit (udhaar). Credit needs a customer name.
   - UPI, card and bank are records only. The app does not process payments.
4. **Sales History**: search by invoice or customer, filter by date, payment, status. Open a sale to see the receipt, reprint it, or cancel it.
5. **Print**: "Print receipt" (72 mm slip) or "Print A4 invoice" opens your browser's print dialog.

## Rules the app enforces
- A sale is saved in ONE database transaction: it re-checks every product, stock and price, takes the next invoice number, reduces stock once, and saves the sale. If anything fails, nothing is saved. "Sale saved" is shown only after the commit.
- Overselling is blocked (screen and database). Archived products cannot be sold. Whole-number units refuse decimals.
- Every bill has a unique id: repeated clicks or a resent bill cannot save twice. Invoice numbers never repeat.
- Money is calculated in paise, so there are no rounding drifts (3 x 0.10 = 0.30).
- Each line stores the product's cost at the time of sale (cost snapshot). Later cost changes do not alter old profit.
- Sales are never edited or deleted. **Cancel** marks the whole sale cancelled, returns stock exactly once (a second cancel is refused), and records reason and time. Money already received must be refunded by you; the app only records the cancellation.
- Dashboard: Total sales (revenue), cash, UPI, card/bank (recorded) and credit are shown separately. Gross profit = sales before tax, minus discount, minus cost of goods (estimate; a warning shows when an item has no cost). Cancelled sales are excluded.

## Files
- `index.html` structure, pages, dialogs
- `style.css` design system, layouts, receipt and print styles
- `script.js` navigation and live dashboard
- `js/db.js` IndexedDB helper (database version 2; upgrades Phase 2 data without loss)
- `js/util.js` shared helpers (formatting, parsing, toast)
- `js/settings.js` shop details
- `js/products.js` products and inventory (Phase 2)
- `js/sales.js` sale rules: totals, complete, cancel, dashboard numbers
- `js/billing.js` New Sale screen
- `js/history.js` Sales History, sale details, cancellation
- `js/receipt.js` receipt and A4 invoice building and printing

## Data stored (IndexedDB database `dukaan-manager`, version 2)
`products`, `stockHistory`, `sales` (with line items, payments, event log), `counters` (invoice number), `settings`.

## Printing notes
- Printing uses the browser print dialog; the app cannot talk to a thermal printer directly. Install the printer on the device and choose it and its paper size in the dialog.
- The compact slip is 72 mm wide. Margins, paper cutting and fonts depend on the printer driver.
- The A4 invoice is a plain bill. It is **not** a statutory GST tax invoice.

## Not implemented yet
- Customer ledger, linking sales to customer records, repayments (Phase 4). Credit sales store the customer name only. "Customer credit due" is the unpaid amount on completed sales and does not yet reduce when a customer pays.
- Expenses and reports (Phase 5). Dashboard shows expenses as "–".
- Partial returns and refund records. Only whole-sale cancellation exists.
- Backup/restore and data export other than product CSV (Phase 6). Until then, data exists only in this browser.
- Default tax setting (tax is typed per bill), login or user permissions (anyone using the device can cancel a sale), service worker / installable app and offline start (Phase 7), cloud sync (Phase 9).
- A bill being built is kept when you switch pages, but not if you reload (the browser warns first).

## Known limits
- Data lives only in this browser on this device. Clearing site data or losing the device loses it.
- Data is not encrypted and is visible to anyone who uses the device and browser.
- Two tabs or devices have separate data. Use one tab.
- Private/incognito windows may refuse or erase storage; the app shows a message if storage fails.
- The offline indicator reflects browser connectivity only.