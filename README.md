# Dukaan Manager (Phase 5: Expenses & Reports)

Offline-first shop management app for Indian shopkeepers. Plain HTML, CSS and JavaScript, no build step.

## Status
- **Phase 1** done: responsive layout, navigation, dashboard.
- **Phase 2** done: products and inventory (IndexedDB).
- **Phase 3** done: billing, sales history, receipt and invoice printing, shop details for receipts.
- **Phase 4** done: customers, udhaar ledger, repayments, linking earlier credit sales.
- **Phase 5** done: expenses and date-filtered reports.
- Everything shown is real data saved on this device. There is no sample data any more.

## Run it
Serve the folder (browser storage is most reliable on http://localhost):

    cd dukaan-manager
    python3 -m http.server 8000

then open http://localhost:8000. Opening `index.html` directly may work, but some browsers restrict storage for `file://` pages.

## Using Phase 5 (expenses and reports)
- **Expenses**: add, edit, search, filter by date, category and status. Categories: Rent, Electricity, Salary, Transport, Supplies, Maintenance, Other. Amounts are stored as integer paise (`amountP`). Expenses are never deleted: **Void** keeps the record with a reason, and edits are logged in its history.
- **Reports**: Today, This week (Monday to today), This month, or a custom range. Sales exclude cancelled bills. Money received is separate and includes customer repayments, which are never counted as sales. Customer credit is the ledger total today (not limited to the period). Gross profit and the net operating result are shown only when every sale in the period has a saved cost; otherwise they say "Unavailable".
- Database upgrades 3 to 4 by adding only the `expenses` store.

## Using Phase 4 (customers and udhaar)
1. **Customers & Udhaar > + Add Customer**: name (required), phone, address, notes, and an optional opening balance (money owed before you started using the app; it can only be entered when the customer is added). A customer with the same phone as another gives a warning, and you may still save.
2. **New Sale**: pick a customer by name or phone, or tap **+ New customer** (the bill is kept). A customer is required only when part or all of the bill is on credit; you confirm the credit amount before the sale saves. Cash or UPI sales can be walk-in or attached to a customer.
3. **Customer page** (tap Open): balance, bills still owed, payments received, and the ledger (filter by type and date, newest first, running balance, CSV export). Archiving hides the customer from new bills but keeps all history; you can still record their repayments.
4. **Receive payment**: choose method, amount, optional reference and note. Money is applied to the oldest bills first, or choose the bills yourself. You review and confirm before it saves, then get a printable slip. A payment cannot exceed what is owed. A repayment is not a sale: it never changes stock or sales totals.
5. **Earlier credit sales** made in Phase 3 only stored a name. A notice on the Customers page lets you link them to customers (creates the ledger entries; sale amounts do not change). Until linked they are shown separately on the dashboard.

## Using Phase 3
1. **Settings > Shop details**: enter shop name, address, phone, invoice prefix and receipt footer (printed on bills).
2. **Products**: add products with stock (Phase 2).
3. **New Sale**: search (or scan a barcode and press Enter), tap Add, change quantities, optionally add a discount (amount or %) and a tax % for that bill, choose how it was paid, then **Complete sale**.
   - Payment starts as "Cash, paid in full". Use UPI, "All on credit (udhaar)", or "+ Part / split payment" for several methods or part payment.
   - Whatever is not paid now becomes credit (udhaar). Credit needs a customer (Phase 4).
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
- `js/db.js` IndexedDB helper (database version 4; upgrades older data without loss)
- `js/expenses.js` expenses and the Expenses screen (Phase 5)
- `js/reports.js` report calculations and screen (Phase 5)
- `js/ledger.js` customers, ledger, repayments and rules (Phase 4)
- `js/customers.js` Customers screens, repayment and linking dialogs (Phase 4)
- `js/util.js` shared helpers (formatting, parsing, toast)
- `js/settings.js` shop details
- `js/products.js` products and inventory (Phase 2)
- `js/sales.js` sale rules: totals, complete, cancel, dashboard numbers
- `js/billing.js` New Sale screen
- `js/history.js` Sales History, sale details, cancellation
- `js/receipt.js` receipt and A4 invoice building and printing

## Data stored (IndexedDB database `dukaan-manager`, version 4)
`products`, `stockHistory`, `sales` (with line items, payments, event log), `counters` (invoice, repayment and ledger numbers), `settings`, and from Phase 4: `customers`, `ledger`, `repayments`, and from Phase 5: `expenses`.

## Ledger rules
- A customer's balance is the sum of their ledger entries (debit = owes more, credit = owes less). It is never stored or typed over.
- Entries are never edited or deleted. A credit sale adds only the unpaid part. A repayment adds a credit entry per bill it was applied to. Cancelling a sale adds one entry that removes what was still unpaid on it (exactly once, enforced by a fixed entry id).
- If a customer had already repaid part of a cancelled bill, only the unpaid remainder is reversed; the sale details show the amount you owe back as a refund (the app records no refund).
- Each repayment form has its own id, so a double click or resend saves once. All repayment writes happen in one transaction.

## Upgrading from Phase 3
Open the new version at the same address. The database upgrades from version 2 to 3 by adding the three new stores only; products, sales, stock history, counters and settings are untouched. Use the same address, since browser storage belongs to one address.

## Printing notes
- Printing uses the browser print dialog; the app cannot talk to a thermal printer directly. Install the printer on the device and choose it and its paper size in the dialog.
- The compact slip is 72 mm wide. Margins, paper cutting and fonts depend on the printer driver.
- The A4 invoice is a plain bill. It is **not** a statutory GST tax invoice.

## Not implemented yet
- Reversing a saved repayment, advance payments (paying more than owed), editing an opening balance after creation, refund records, customer deletion (archive only).
- Backup and restore are NOT built. Customers, ledger and repayments are in IndexedDB and will be included when Phase 6 adds backup. Until then, clearing browser data deletes them.
- Report export/printing, charts, per-product reports, recurring expenses, expense receipts/attachments.
- The Dashboard period selector still shows today only; use Reports for week, month and custom.
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