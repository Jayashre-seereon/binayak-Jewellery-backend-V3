// Shared helpers for the accounting module: input parsing, date windows (shop time = IST,
// forced at boot by config/timezone.js), list pagination and ledger-account resolution.
import { AppError, toDate, toNumber, cleanPhone } from "../../utils/validate.js";
import { ACCOUNTS, ensureAccount } from "../../utils/ledger.js";

export const PAYMENT_MODES = ["CASH", "UPI", "BANK_TRANSFER", "CARD", "CHEQUE", "OTHER"];

// Legacy migrated vouchers are a read-only historical archive.
export const LEGACY_REFERENCE_TYPES = ["RetailInvoice", "OldMetalPurchase", "AdvanceReceive"];
// Journals posted by the sales / purchase modules; they are cancelled through those documents.
export const SYSTEM_JOURNAL_TYPES = ["SALE", "PURCHASE"];

// Earliest date a voucher may carry (start of FY 2019-20, before the oldest migrated data).
export const MIN_VOUCHER_DATE = new Date(2019, 3, 1);

export const parsePaymentMode = (value) => {
  const mode = String(value || "CASH").trim().toUpperCase();
  if (!PAYMENT_MODES.includes(mode)) throw new AppError(`Invalid payment mode: ${value}`);
  return mode;
};

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * Voucher date: defaults to now; never in the future (beyond today, shop time) and never
 * before MIN_VOUCHER_DATE. Period locking is a policy follow-up (no lock-date setting yet).
 */
export const parseVoucherDate = (value) => {
  const d = toDate(value, { field: "Voucher date", allowFutureDays: null });
  if (d.getTime() >= addDays(startOfDay(new Date()), 1).getTime()) {
    throw new AppError("Voucher date cannot be in the future.");
  }
  if (d.getTime() < MIN_VOUCHER_DATE.getTime()) {
    throw new AppError("Voucher date cannot be before 01-Apr-2019.");
  }
  return d;
};

/** [start, end) of the calendar day for a YYYY-MM-DD filter value (shop time). */
export const dayWindow = (value, field) => {
  const d = toDate(value, { field, allowFutureDays: null, defaultValue: null });
  if (!d) return null;
  // A bare YYYY-MM-DD is parsed as UTC midnight; take the calendar date the user typed.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  const start = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : startOfDay(d);
  return { start, end: addDays(start, 1) };
};

export const todayWindow = (now = new Date()) => {
  const start = startOfDay(now);
  return { start, end: addDays(start, 1) };
};

export const monthWindow = (now = new Date()) => ({
  start: new Date(now.getFullYear(), now.getMonth(), 1),
  end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
});

export const parsePagination = (query = {}, { defaultLimit = 50, maxLimit = 200 } = {}) => {
  const page = toNumber(query.page, { field: "page", min: 1, max: 1e6, int: true, defaultValue: 1 });
  const limit = toNumber(query.limit, { field: "limit", min: 1, max: maxLimit, int: true, defaultValue: defaultLimit });
  return { page, limit, skip: (page - 1) * limit };
};

/** Exact 10-digit phone (last 10 digits) or "" when the input is not a usable phone. */
export const exactPhone = (value) => {
  const p = cleanPhone(value);
  return p.length === 10 ? p : "";
};

export const actorOf = (user) => String(user?.name || user?.email || "System").slice(0, 120);

export const DEFAULT_ACCOUNTS = [
  { accountName: ACCOUNTS.CASH, accountGroup: "Cash", accountType: "ASSET", isSystem: true },
  { accountName: ACCOUNTS.BANK, accountGroup: "Bank", accountType: "ASSET", isSystem: true },
  { accountName: ACCOUNTS.CUSTOMER_RECEIVABLES, accountGroup: "Sundry Debtors", accountType: "ASSET", isSystem: true },
  { accountName: ACCOUNTS.SUPPLIER_PAYABLES, accountGroup: "Sundry Creditors", accountType: "LIABILITY", isSystem: true },
  { accountName: ACCOUNTS.CUSTOMER_ADVANCES, accountGroup: "Current Liabilities", accountType: "LIABILITY", isSystem: true },
  { accountName: ACCOUNTS.SALES, accountGroup: "Sales", accountType: "INCOME", isSystem: true },
  { accountName: ACCOUNTS.PURCHASE, accountGroup: "Purchases", accountType: "EXPENSE", isSystem: true },
  { accountName: ACCOUNTS.OLD_GOLD_PURCHASE, accountGroup: "Purchases", accountType: "EXPENSE", isSystem: true },
  { accountName: ACCOUNTS.OUTPUT_CGST, accountGroup: "Duties & Taxes", accountType: "LIABILITY", isSystem: true },
  { accountName: ACCOUNTS.OUTPUT_SGST, accountGroup: "Duties & Taxes", accountType: "LIABILITY", isSystem: true },
  { accountName: ACCOUNTS.OUTPUT_IGST, accountGroup: "Duties & Taxes", accountType: "LIABILITY", isSystem: true },
  { accountName: ACCOUNTS.INPUT_CGST, accountGroup: "Duties & Taxes", accountType: "ASSET", isSystem: true },
  { accountName: ACCOUNTS.INPUT_SGST, accountGroup: "Duties & Taxes", accountType: "ASSET", isSystem: true },
  { accountName: ACCOUNTS.INPUT_IGST, accountGroup: "Duties & Taxes", accountType: "ASSET", isSystem: true },
  { accountName: ACCOUNTS.ROUND_OFF, accountGroup: "Indirect Expenses", accountType: "EXPENSE", isSystem: true },
  { accountName: ACCOUNTS.OTHER_INCOME, accountGroup: "Indirect Income", accountType: "INCOME", isSystem: false },
  { accountName: "Salary Expense", accountGroup: "Indirect Expenses", accountType: "EXPENSE", isSystem: false },
  { accountName: "Rent Expense", accountGroup: "Indirect Expenses", accountType: "EXPENSE", isSystem: false },
  { accountName: "Electricity Expense", accountGroup: "Indirect Expenses", accountType: "EXPENSE", isSystem: false },
  { accountName: "Transport Expense", accountGroup: "Indirect Expenses", accountType: "EXPENSE", isSystem: false },
  { accountName: "Bank Charges", accountGroup: "Indirect Expenses", accountType: "EXPENSE", isSystem: false },
  { accountName: "Depreciation Expense", accountGroup: "Indirect Expenses", accountType: "EXPENSE", isSystem: false },
  { accountName: "Other Business Expenses", accountGroup: "Indirect Expenses", accountType: "EXPENSE", isSystem: false },
  { accountName: "Capital / Owner Equity", accountGroup: "Capital", accountType: "EQUITY", isSystem: false },
  { accountName: "Opening Balance Adjustment", accountGroup: "Capital", accountType: "EQUITY", isSystem: false },
];

const KNOWN_NAMES = new Map(DEFAULT_ACCOUNTS.map((a) => [a.accountName.toLowerCase(), a]));

export const EXPENSE_ACCOUNT_BY_TYPE = {
  SALARY: "Salary Expense",
  RENT: "Rent Expense",
  ELECTRICITY: "Electricity Expense",
  TRANSPORT: "Transport Expense",
  EXPENSE: "Other Business Expenses",
  OTHER: "Other Business Expenses",
};

/**
 * Resolves a user-entered ledger name to an existing account of THIS store (case-insensitive,
 * whitespace-normalised). Known system/default names are created on demand; anything else
 * must already exist, so a typo cannot create a phantom ledger.
 */
export const resolveAccountName = async (tx, storeId, rawName, { field = "Account" } = {}) => {
  const name = String(rawName || "").replace(/\s+/g, " ").trim();
  if (!name) throw new AppError(`${field} name is required.`);
  const existing = await tx.account.findFirst({
    where: { storeId: Number(storeId), accountName: { equals: name, mode: "insensitive" } },
    select: { id: true, accountName: true },
  });
  if (existing) return existing.accountName;
  const known = KNOWN_NAMES.get(name.toLowerCase());
  if (known) {
    const { accountName, ...meta } = known;
    const acc = await ensureAccount(tx, storeId, accountName, meta);
    return acc.accountName;
  }
  throw new AppError(`Ledger account "${name}" does not exist in this store. Create it under Accounts first.`, 400);
};
