/*
 * DEMO DATA ONLY.
 * These are sample numbers for the Phase 1 prototype. They are not real
 * shop records and will be deleted once IndexedDB storage is added (Phase 6).
 * Amounts are in rupees.
 */
const DEMO = {
  shopName: "Demo Kirana Store",
  today: {
    sales: 18450,
    cash: 9200,
    upi: 5400,
    credit: 3850,
    expenses: 2300,
    grossProfit: 4120
  },
  stock: {
    totalProducts: 142,
    lowStock: 7,
    outstandingCredit: 46780
  },
  recent: [
    { invoice: "DEMO-0006", time: "11:42 AM", customer: "Walk-in",      method: "Cash",    amount: 640 },
    { invoice: "DEMO-0005", time: "11:15 AM", customer: "Ramesh Kumar", method: "Udhaar",  amount: 1850 },
    { invoice: "DEMO-0004", time: "10:50 AM", customer: "Walk-in",      method: "UPI",     amount: 2200 },
    { invoice: "DEMO-0003", time: "10:20 AM", customer: "Sunita Devi",  method: "Split",   amount: 3100 },
    { invoice: "DEMO-0002", time: "09:48 AM", customer: "Walk-in",      method: "Cash",    amount: 410 },
    { invoice: "DEMO-0001", time: "09:30 AM", customer: "Walk-in",      method: "UPI",     amount: 750 }
  ]
};