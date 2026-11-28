/**
 * A fixed category list for tests of ledger logic (receipts, recurring bills, manager paperwork, imports…), so they
 * don't change when the starter categories in seed.ts do: `seedDefaults(db, TEST_CATEGORIES)`.
 */
export const TEST_CATEGORIES = [
  { name: "Rental Income", kind: "income", schedule_e_line: "3", default_allocation: null },
  { name: "Cleaning", kind: "expense", schedule_e_line: "7", default_allocation: "direct" },
  { name: "Maintenance", kind: "expense", schedule_e_line: "14", default_allocation: "direct" },
  { name: "Supplies", kind: "expense", schedule_e_line: "15", default_allocation: "direct" },
  { name: "Furnishings", kind: "expense", schedule_e_line: "19", default_allocation: "direct" },
  { name: "Management Fee", kind: "expense", schedule_e_line: "11", default_allocation: "direct" },
  { name: "Platform Fees", kind: "expense", schedule_e_line: "8", default_allocation: "direct" },
  { name: "Utilities", kind: "expense", schedule_e_line: "17", default_allocation: "direct" },
  { name: "Services", kind: "expense", schedule_e_line: "19", default_allocation: "direct" },
  { name: "Taxes", kind: "expense", schedule_e_line: "16", default_allocation: "direct" },
  { name: "Insurance", kind: "expense", schedule_e_line: "9", default_allocation: "indirect" },
  { name: "Mortgage", kind: "expense", schedule_e_line: "12", default_allocation: "indirect" },
  { name: "Property Tax", kind: "expense", schedule_e_line: "16", default_allocation: "indirect" },
  { name: "Professional Fees", kind: "expense", schedule_e_line: "10", default_allocation: "direct" },
  { name: "Advertising", kind: "expense", schedule_e_line: "5", default_allocation: "direct" },
  { name: "Travel", kind: "expense", schedule_e_line: "6", default_allocation: "direct" },
] as const;
