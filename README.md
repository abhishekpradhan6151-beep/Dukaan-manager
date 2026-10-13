# Dukaan Manager (Phase 2: Products & Inventory)

Offline-first shop management app for Indian shopkeepers. Plain HTML, CSS and JavaScript, no build step.

## Status
- **Phase 1** (done): responsive layout, navigation, dashboard, page shells.
- **Phase 2** (done): product management and inventory, saved on the device in IndexedDB.
- Dashboard sales, payment, expense, profit and customer-credit figures are still **sample data** from `demo-data.js`.
  The "Total products" and "Low stock" cards are live from your saved products.

## Run it
Serve the folder (recommended, because browser storage is most reliable on http://localhost):

    cd dukaan-manager
    python3 -m http.server 8000

then open http://localhost:8000. Opening `index.html` directly may also work, but some browsers restrict storage for `file://` pages.

## What works in Phase 2
- Add, edit, view products. Fields: name, SKU, barcode, category, unit, cost, price, stock, low-stock level, description, timestamps, active/archived.
- Search (name, SKU, barcode), category filter, status filter, low-stock filter, sorting, "Show more" paging (50 at a time).
- Stock changes only through opening stock and **Adjust stock**, each with a reason and a history entry. Editing a product never changes stock.
- Negative stock is blocked. Decimal quantities allowed only for kg, g, litre, ml, metre.
- Duplicate SKU and price-below-cost produce a warning (you can still save). Duplicate IDs are rejected by the database.
- Archive and restore (history kept).
- Export all products to CSV (formula characters are neutralised for Excel safety).
- Saves are confirmed only after the database transaction commits; storage errors are shown, not hidden.

## Files
- `index.html` structure, page shells, product dialogs
- `style.css` design system and responsive layouts
- `script.js` navigation and dashboard
- `js/db.js` IndexedDB helper (transactions, error messages)
- `js/products.js` product rules (data section) and product screens (UI section)
- `demo-data.js` demo numbers (removed when real sales and customers exist)

## Data stored (IndexedDB database `dukaan-manager`)
- `products`: one record per product.
- `stockHistory`: one record per stock change (opening stock or adjustment).

## Not implemented yet
Billing and receipts (Phase 3), customers/udhaar (4), expenses and reports (5), backup/restore and editable shop settings (6), service worker / installable app (7), cloud sync (9).

## Known limits
- Data lives only in this browser on this device. Clearing site data or losing the device loses it. Backup/restore arrives in Phase 6, so use **Export CSV** as a safety copy for now.
- Data is not encrypted and is visible to anyone who uses the device and browser.
- Private/incognito windows may refuse or erase storage; the app shows a message if storage fails.
- The app is not yet usable offline after closing the browser (service worker is Phase 7).
- The offline indicator reflects browser connectivity only.