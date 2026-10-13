# Dukaan Manager (Phase 4: Customer Management & Udhaar Ledger)

Offline-first shop management app for Indian shopkeepers. Plain HTML, CSS and vanilla JavaScript, no build step.

## Status
- **Phase 1** done: responsive layout, navigation, dashboard.
- **Phase 2** done: products and inventory (IndexedDB).
- **Phase 3** done: billing, sales history, receipt and invoice printing, shop details for receipts.
- **Phase 4** done: customer management, udhaar ledger, multi-bill repayments, running balances, credit cancellation reversal, and repayment receipts.
- Everything shown is real data saved on this device. There is no sample data.

## Run it
Serve the folder (browser storage is most reliable on http://localhost):

    cd dukaan-manager
    python3 -m http.server 8000

then open http://localhost:8000. Opening `index.html` directly may work, but some browsers restrict storage for `file://` pages.

## Using Phase 4
1. **Customers & Udhaar**:
   - Access via the sidebar navigation or bottom navigation on mobile ("Udhaar"), or dashboard quick actions ("+ Add Customer" / "Customers & Udhaar").
   - **Add Customer**: Name (required), phone number (optional), address, and notes. Duplicate phone numbers trigger a warning while allowing you to proceed if intended.
   - **Customer Profile & Ledger**: Tap on any customer to see their total outstanding balance, outstanding bills count, contact details, outstanding invoices list, and complete chronological udhaar ledger with running balances.
   - **Filter Ledger**: Filter ledger entries by date range (`From`, `To`) and transaction type (Credit sales, Repayments, Cancellations).
   - **Archive / Restore**: Archive customers without losing their ledger entries or sales history.
2. **Billing with Customers**:
   - In **New Sale**, select an existing customer or search by name / phone number.
   - Click **+ New Customer** right in the billing panel to add a customer immediately without clearing or losing items in your cart.
   - The selected customer's live credit balance is displayed right on the billing screen.
   - Fully paid sales can optionally be attached to a customer.
   - Credit sales (where payment received is less than total) **require** a registered customer.
3. **Recording Repayments**:
   - Tap **Record Repayment** from the customer profile, customer card, or outstanding bills list.
   - Enter the repayment amount received (cash, UPI, card, or bank transfer).
   - Click **Pay full balance** or **Auto-allocate (oldest first)** to automatically distribute repayment across unpaid bills, or customize allocations per bill.
   - Repayments cannot exceed the customer's total outstanding balance (advance payments are prohibited).
   - Review confirmation details before committing the repayment to database.
   - Print a compact slip (72 mm) or A4 invoice payment confirmation receipt after recording.
4. **Cancellation with Credit Reversal**:
   - When a credit sale is cancelled from Sales History, stock is restored, active unpaid credit is reversed from the customer's ledger, and any repayments made towards that bill are tracked in the refund due amount.

## Rules the app enforces
- **Auditable Ledger**: Customer balances are calculated dynamically from immutable ledger entries, never from a manually editable balance field.
- **Single Atomic Transactions**: All related financial updates (sale + stock + customer ledger, or repayment + allocations + customer ledger) commit together in ONE transaction. Success is displayed only after the transaction commits.
- **Financial Integrity**:
  - Repayments never increase sales revenue or alter inventory stock.
  - Credit sales increase the customer's balance by the unpaid portion only.
  - Cancelled sales reverse credit exactly once and cannot be cancelled twice.
  - Duplicate repayment submissions and over-allocations are strictly prevented.
- **Paise Precision**: All money calculations use paise (integers) to prevent floating-point rounding errors.

## Files
- `index.html` structure, views, dialogs (products, customers, repayments, sales)
- `style.css` design system, responsive tables, cards, print layouts
- `script.js` navigation and live dashboard
- `js/db.js` IndexedDB helper (database version 3; upgrades Phase 2 and 3 data without loss)
- `js/util.js` shared helpers (formatting, parsing, toast)
- `js/settings.js` shop details
- `js/products.js` products and inventory (Phase 2)
- `js/sales.js` sale rules: totals, complete, cancel, customer credit integration
- `js/customers.js` customer management, udhaar ledger, repayment recording (Phase 4)
- `js/billing.js` New Sale screen with customer selection and quick-add
- `js/history.js` Sales History, sale details, cancellation
- `js/receipt.js` sales and repayment receipt / invoice building and printing
- `test_phase4.js` automated test suite covering all 18 Phase 4 verification scenarios

## Data stored (IndexedDB database `dukaan-manager`, version 3)
- `products`: product catalog, stock, pricing, and cost snapshots
- `stockHistory`: audit log of stock movements (additions, sales, cancellations)
- `sales`: completed and cancelled sales with line items, payments, and customer IDs
- `counters`: auto-incrementing counters for invoice numbers and repayment receipts
- `settings`: shop profile details
- `customers`: customer contact details, timestamps, and active/archived status
- `customerLedger`: auditable ledger entries (credit sales, repayments, cancellations)
- `repayments`: repayment transaction records with method and notes
- `repaymentAllocations`: allocation breakdown of repayments across specific invoices

## Database Migration (v2 to v3)
Upgrades existing Phase 3 databases seamlessly on load:
- Preserves all existing `products`, `stockHistory`, `sales`, `counters`, and `settings` stores without data loss.
- Adds new object stores: `customers`, `customerLedger`, `repayments`, `repaymentAllocations`.
- Adds `customerId` index on `sales` store.

## Not implemented yet
- Expenses and profit & loss reports (Phase 5).
- Full database backup & restore export/import (Phase 6).
- Offline service worker caching / PWA installability (Phase 7).
- Cloud synchronization and multi-device support (Phase 9).

## Verification & Testing
Run the offline automated test suite directly:

    node test_phase4.js