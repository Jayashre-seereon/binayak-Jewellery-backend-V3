// Double-entry ledger helper. Every money flow (sales, purchases, receipts, payments,
// journals, cancellations) posts through here so that:
//   * each voucher is balanced (sum debit = sum credit),
//   * every LedgerEntry is linked to an Account row (accountId), created on demand,
//   * Account.currentBalance moves with every posting (debit-positive convention) and is
//     reversed on cancellation.
import prisma from "../config/db.js";
import { AppError, roundMoney } from "./validate.js";

export const ACCOUNTS = {
  CASH: "Cash in Hand",
  BANK: "Bank / UPI Account",
  CUSTOMER_RECEIVABLES: "Customer Receivables",
  SUPPLIER_PAYABLES: "Supplier Payables",
  CUSTOMER_ADVANCES: "Customer Advances",
  SALES: "Jewellery Sales Account",
  PURCHASE: "Jewellery Purchase Account",
  OLD_GOLD_PURCHASE: "Old Gold Purchase Account",
  OUTPUT_CGST: "Output CGST",
  OUTPUT_SGST: "Output SGST",
  OUTPUT_IGST: "Output IGST",
  INPUT_CGST: "Input CGST",
  INPUT_SGST: "Input SGST",
  INPUT_IGST: "Input IGST",
  ROUND_OFF: "Round Off",
  OTHER_INCOME: "Other Income",
};

const META = {
  [ACCOUNTS.CASH]: { accountGroup: "Cash", accountType: "ASSET", isSystem: true },
  [ACCOUNTS.BANK]: { accountGroup: "Bank", accountType: "ASSET", isSystem: true },
  [ACCOUNTS.CUSTOMER_RECEIVABLES]: { accountGroup: "Sundry Debtors", accountType: "ASSET", isSystem: true },
  [ACCOUNTS.SUPPLIER_PAYABLES]: { accountGroup: "Sundry Creditors", accountType: "LIABILITY", isSystem: true },
  [ACCOUNTS.CUSTOMER_ADVANCES]: { accountGroup: "Current Liabilities", accountType: "LIABILITY", isSystem: true },
  [ACCOUNTS.SALES]: { accountGroup: "Sales", accountType: "INCOME", isSystem: true },
  [ACCOUNTS.PURCHASE]: { accountGroup: "Purchases", accountType: "EXPENSE", isSystem: true },
  [ACCOUNTS.OLD_GOLD_PURCHASE]: { accountGroup: "Purchases", accountType: "EXPENSE", isSystem: true },
  [ACCOUNTS.OUTPUT_CGST]: { accountGroup: "Duties & Taxes", accountType: "LIABILITY", isSystem: true },
  [ACCOUNTS.OUTPUT_SGST]: { accountGroup: "Duties & Taxes", accountType: "LIABILITY", isSystem: true },
  [ACCOUNTS.OUTPUT_IGST]: { accountGroup: "Duties & Taxes", accountType: "LIABILITY", isSystem: true },
  [ACCOUNTS.INPUT_CGST]: { accountGroup: "Duties & Taxes", accountType: "ASSET", isSystem: true },
  [ACCOUNTS.INPUT_SGST]: { accountGroup: "Duties & Taxes", accountType: "ASSET", isSystem: true },
  [ACCOUNTS.INPUT_IGST]: { accountGroup: "Duties & Taxes", accountType: "ASSET", isSystem: true },
  [ACCOUNTS.ROUND_OFF]: { accountGroup: "Indirect Expenses", accountType: "EXPENSE", isSystem: true },
  [ACCOUNTS.OTHER_INCOME]: { accountGroup: "Indirect Income", accountType: "INCOME", isSystem: false },
};

const label = (name, phone) => {
  const n = String(name || "").trim() || "Walk-in";
  const p = String(phone || "").replace(/\D/g, "").slice(-10);
  return p ? `${n} (${p})` : n;
};
/** Party sub-ledgers. Phone is included so two customers with the same name never merge. */
export const customerAccount = (name, phone) => `Customer: ${label(name, phone)}`;
export const customerAdvanceAccount = (name, phone) => `Customer Advance: ${label(name, phone)}`;
export const supplierAccount = (name, phone) => `Supplier: ${label(name, phone)}`;
export const paymentAccount = (mode) => (String(mode || "CASH").toUpperCase() === "CASH" ? ACCOUNTS.CASH : ACCOUNTS.BANK);

const metaFor = (accountName) => {
  if (META[accountName]) return META[accountName];
  if (accountName.startsWith("Customer Advance:")) return { accountGroup: "Customer Advances", accountType: "LIABILITY", isSystem: false };
  if (accountName.startsWith("Customer:")) return { accountGroup: "Sundry Debtors", accountType: "ASSET", isSystem: false };
  if (accountName.startsWith("Supplier:")) return { accountGroup: "Sundry Creditors", accountType: "LIABILITY", isSystem: false };
  if (/expense/i.test(accountName)) return { accountGroup: "Indirect Expenses", accountType: "EXPENSE", isSystem: false };
  return { accountGroup: "General", accountType: "EXPENSE", isSystem: false };
};

/** Finds or creates an account by name in the store (race-safe). */
export const ensureAccount = async (tx, storeId, accountName, meta = undefined) => {
  const sid = Number(storeId);
  const name = String(accountName || "").trim();
  if (!name) throw new AppError("Ledger account name is required.");
  const where = { storeId_accountName: { storeId: sid, accountName: name } };
  const found = await tx.account.findUnique({ where, select: { id: true, accountName: true } });
  if (found) return found;
  const m = { ...metaFor(name), ...(meta || {}) };
  try {
    return await tx.account.create({ data: { storeId: sid, accountName: name, ...m }, select: { id: true, accountName: true } });
  } catch (err) {
    if (err?.code === "P2002") return tx.account.findUnique({ where, select: { id: true, accountName: true } });
    throw err;
  }
};

/** Normalises entry rows and checks balance. Rows with 0/0 are dropped; a row may not have both sides. */
export const normaliseEntries = (entries = []) => {
  const rows = [];
  let totalDebit = 0;
  let totalCredit = 0;
  for (const e of entries) {
    const debit = roundMoney(e.debit || 0);
    const credit = roundMoney(e.credit || 0);
    if (debit < 0 || credit < 0) throw new AppError("Ledger amounts cannot be negative.");
    if (debit > 0 && credit > 0) throw new AppError(`Ledger row "${e.accountName}" cannot have both debit and credit.`);
    if (debit === 0 && credit === 0) continue;
    rows.push({ ...e, debit, credit });
    totalDebit = roundMoney(totalDebit + debit);
    totalCredit = roundMoney(totalCredit + credit);
  }
  if (rows.length < 2) throw new AppError("A voucher needs at least one debit and one credit line.");
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new AppError(`Voucher is not balanced (debit ${totalDebit.toFixed(2)} vs credit ${totalCredit.toFixed(2)}).`);
  }
  return { rows, totalDebit, totalCredit };
};

/**
 * Creates a Voucher with balanced LedgerEntries and moves account balances.
 * `voucher` = Prisma Voucher create data WITHOUT `entries`/`storeId` handling (storeId required inside).
 */
export const postVoucher = async (tx, voucher, entries) => {
  const storeId = Number(voucher.storeId);
  const date = voucher.date ? new Date(voucher.date) : new Date();
  const { rows, totalDebit } = normaliseEntries(entries);
  const prepared = [];
  for (const r of rows) {
    const acc = await ensureAccount(tx, storeId, r.accountName, r.meta);
    prepared.push({
      storeId,
      accountId: acc.id,
      accountName: acc.accountName,
      entryType: r.debit > 0 ? "DEBIT" : "CREDIT",
      debit: r.debit,
      credit: r.credit,
      narration: r.narration || voucher.narration || null,
      date,
      status: "COMPLETED",
    });
  }
  const created = await tx.voucher.create({
    data: {
      ...voucher,
      storeId,
      date,
      amount: voucher.amount !== undefined ? roundMoney(voucher.amount) : totalDebit,
      status: voucher.status || "COMPLETED",
      entries: { create: prepared },
    },
    include: { entries: true },
  });
  for (const p of prepared) {
    await tx.account.update({ where: { id: p.accountId }, data: { currentBalance: { increment: roundMoney(p.debit - p.credit) } } });
  }
  return created;
};

/** Marks a voucher's entries CANCELLED and reverses their effect on account balances. Idempotent. */
export const reverseVoucherEntries = async (tx, voucherId) => {
  const entries = await tx.ledgerEntry.findMany({ where: { voucherId: Number(voucherId), status: "COMPLETED" } });
  for (const e of entries) {
    const acc = e.accountId ? { id: e.accountId } : await ensureAccount(tx, e.storeId, e.accountName);
    await tx.account.update({ where: { id: acc.id }, data: { currentBalance: { decrement: roundMoney(Number(e.debit) - Number(e.credit)) } } });
  }
  if (entries.length) {
    await tx.ledgerEntry.updateMany({ where: { voucherId: Number(voucherId), status: "COMPLETED" }, data: { status: "CANCELLED" } });
  }
  return entries.length;
};

/**
 * Atomically flips a voucher COMPLETED -> CANCELLED (first writer wins) and reverses its ledger.
 * Returns false when the voucher was already cancelled (caller should 400).
 */
export const cancelVoucherAtomic = async (tx, { voucherId, storeId, reason, cancelledBy }) => {
  const flipped = await tx.voucher.updateMany({
    where: { id: Number(voucherId), storeId: Number(storeId), status: "COMPLETED" },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelledReason: reason || null, createdBy: undefined },
  });
  if (flipped.count === 0) return false;
  await reverseVoucherEntries(tx, voucherId);
  return true;
};

export const ensureSystemAccounts = async (storeId, tx = prisma) => {
  for (const name of Object.values(ACCOUNTS)) await ensureAccount(tx, storeId, name);
};
