import prisma from "../../../config/db.js";
import { roundMoney } from "../../../utils/validate.js";
import { n, dateKey, sumBy } from "../engine.js";
import { formatMoney } from "../theme.js";
import {
  VOUCHER_STATUS_FILTER,
  PAYMENT_MODE_FILTER,
  SEARCH_FILTER,
  INCLUDE_LEGACY_FILTER,
  LEGACY_REF_TYPES,
  nonLegacyVoucher,
  isLegacyRef,
  referenceLabel,
  normaliseMode,
  MODE_LABEL,
  contains,
  dateRangeWhere,
  drCr,
  titleCase,
} from "./common.js";

const voucherWhere = (storeId, range, filters, extra = {}) => {
  const and = [];
  const where = { storeId, ...extra };
  const d = dateRangeWhere(range);
  if (d) where.date = d;
  if (filters.status && filters.status !== "ALL") where.status = filters.status;
  if (filters.includeLegacy === false) and.push(nonLegacyVoucher);
  if (filters.search) {
    and.push({ OR: [{ voucherNo: contains(filters.search) }, { partyName: contains(filters.search) }, { narration: contains(filters.search) }, { referenceDocNo: contains(filters.search) }] });
  }
  if (and.length) where.AND = and;
  return where;
};

const VOUCHER_SELECT = {
  id: true,
  voucherNo: true,
  date: true,
  amount: true,
  paymentMode: true,
  referenceType: true,
  referenceDocNo: true,
  partyName: true,
  partyPhone: true,
  narration: true,
  status: true,
  bankName: true,
  transactionRef: true,
};

// ---------------------------------------------------------------- receipt / payment registers
const voucherRegister = (type) => ({
  key: type === "RECEIPT" ? "receipt-register" : "payment-register",
  name: type === "RECEIPT" ? "Receipt Voucher Register" : "Payment Voucher Register",
  group: "Accounts",
  description:
    type === "RECEIPT"
      ? "All receipt vouchers — sale dues, advances and other income — with mode, party and reference."
      : "All payment vouchers — supplier and old-gold payments, expenses — with mode, party and reference.",
  orientation: "landscape",
  defaultPeriod: "THIS_MONTH",
  filters: [VOUCHER_STATUS_FILTER, PAYMENT_MODE_FILTER, INCLUDE_LEGACY_FILTER(true), SEARCH_FILTER("Voucher / party / narration")],
  columns: (f) => [
    { key: "date", label: "Date", type: "date" },
    { key: "voucherNo", label: "Voucher No", type: "text" },
    { key: "party", label: type === "RECEIPT" ? "Received From" : "Paid To", type: "text" },
    { key: "phone", label: "Phone", type: "text", pdf: false },
    { key: "reference", label: "Against", type: "text" },
    { key: "mode", label: "Mode", type: "text" },
    { key: "account", label: type === "RECEIPT" ? "Deposited To" : "Paid From", type: "text", pdf: false },
    { key: "narration", label: "Narration", type: "text" },
    { key: "amount", label: "Amount", type: "money", total: true },
    ...(f.status !== "COMPLETED" ? [{ key: "status", label: "Status", type: "text" }] : []),
  ],
  query: async (storeId, range, filters) => {
    const where = voucherWhere(storeId, range, filters, { voucherType: type });
    const [vouchers, sideEntries] = await Promise.all([
      prisma.voucher.findMany({ where, select: VOUCHER_SELECT, orderBy: [{ date: "asc" }, { id: "asc" }] }),
      // the cash/bank side of each voucher (receipt = debit line, payment = credit line)
      prisma.ledgerEntry.findMany({
        where: { storeId, voucher: { is: where } },
        select: { voucherId: true, accountName: true, debit: true, credit: true },
      }),
    ]);
    // the largest line on the money side names the cash/bank account used
    const sideAccount = new Map();
    const best = new Map();
    for (const e of sideEntries) {
      const { dr, cr } = drCr(e);
      const amt = type === "RECEIPT" ? dr : cr;
      if (amt > (best.get(e.voucherId) || 0)) {
        best.set(e.voucherId, amt);
        sideAccount.set(e.voucherId, e.accountName);
      }
    }
    let rows = vouchers.map((v) => {
      const account = sideAccount.get(v.id) || "";
      return {
        date: dateKey(v.date),
        voucherNo: v.voucherNo,
        party: v.partyName || "",
        phone: v.partyPhone || "",
        reference: referenceLabel(v.referenceType, v.referenceDocNo),
        mode: MODE_LABEL[normaliseMode(v.paymentMode, account)],
        _mode: normaliseMode(v.paymentMode, account),
        account,
        narration: v.narration || "",
        amount: roundMoney(v.amount),
        status: v.status === "CANCELLED" ? "Cancelled" : "Active",
      };
    });
    if (filters.paymentMode !== "ALL") rows = rows.filter((r) => r._mode === filters.paymentMode);
    rows = rows.map(({ _mode, ...r }) => r);
    const active = rows.filter((r) => r.status === "Active");
    const byMode = {};
    for (const r of active) byMode[r.mode] = (byMode[r.mode] || 0) + r.amount;
    const summary = [
      { label: "Vouchers", value: rows.length, type: "number" },
      { label: type === "RECEIPT" ? "Total Received" : "Total Paid", value: roundMoney(sumBy(active, "amount")), type: "money" },
      ...Object.entries(byMode)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([m, v]) => ({ label: m, value: roundMoney(v), type: "money" })),
    ];
    if (filters.status !== "COMPLETED") summary.push({ label: "Cancelled", value: rows.length - active.length, type: "number" });
    return { rows, summary };
  },
});

// ---------------------------------------------------------------- journal register / day book (entry level)
const entryRows = async (storeId, voucherWhereInput, statusFilter) => {
  const entries = await prisma.ledgerEntry.findMany({
    where: { storeId, voucher: { is: voucherWhereInput }, ...(statusFilter === "ALL" ? {} : { status: statusFilter || "COMPLETED" }) },
    select: {
      id: true,
      accountName: true,
      debit: true,
      credit: true,
      narration: true,
      voucherId: true,
      voucher: { select: { voucherNo: true, voucherType: true, date: true, referenceType: true, referenceDocNo: true, partyName: true, narration: true, status: true } },
    },
    orderBy: [{ voucher: { date: "asc" } }, { voucherId: "asc" }, { id: "asc" }],
  });
  return entries.map((e) => {
    const { dr, cr } = drCr(e);
    const v = e.voucher;
    return {
      date: dateKey(v.date),
      voucherNo: v.voucherNo,
      type: titleCase(v.voucherType),
      account: e.accountName,
      particulars: [v.partyName, e.narration || v.narration].filter(Boolean).join(" — ") || referenceLabel(v.referenceType, v.referenceDocNo),
      reference: referenceLabel(v.referenceType, v.referenceDocNo),
      debit: roundMoney(dr),
      credit: roundMoney(cr),
      status: v.status === "CANCELLED" ? "Cancelled" : "Active",
      _voucherId: e.voucherId,
    };
  });
};

/** Blanks the date/voucher cells on the 2nd+ line of the same voucher (cleaner print). */
const markContinuation = (rows) => {
  let prev = null;
  for (const r of rows) {
    r._cont = prev === r._voucherId;
    prev = r._voucherId;
    delete r._voucherId;
  }
  return rows;
};

const journalRegister = {
  key: "journal-register",
  name: "Journal Register",
  group: "Accounts",
  description: "Journal vouchers line by line (account, debit, credit). System sale/purchase journals are optional.",
  orientation: "landscape",
  defaultPeriod: "THIS_MONTH",
  filters: [
    { name: "includeSystem", label: "Include sale / purchase journals", type: "boolean", default: false },
    VOUCHER_STATUS_FILTER,
    SEARCH_FILTER("Voucher / party / narration"),
  ],
  columns: [
    { key: "date", label: "Date", type: "date" },
    { key: "voucherNo", label: "Voucher No", type: "text" },
    { key: "account", label: "Account", type: "text" },
    { key: "particulars", label: "Particulars", type: "text" },
    { key: "reference", label: "Reference", type: "text", pdf: false },
    { key: "debit", label: "Debit", type: "money", total: true },
    { key: "credit", label: "Credit", type: "money", total: true },
    { key: "status", label: "Status", type: "text", pdf: false },
  ],
  query: async (storeId, range, filters) => {
    const where = voucherWhere(storeId, range, filters, { voucherType: "JOURNAL" });
    if (!filters.includeSystem) where.AND = [...(where.AND || []), { OR: [{ referenceType: null }, { referenceType: { notIn: ["SALE", "PURCHASE"] } }] }];
    const rows = markContinuation(await entryRows(storeId, where, filters.status === "ALL" ? "ALL" : filters.status === "CANCELLED" ? "CANCELLED" : "COMPLETED"));
    const vouchers = await prisma.voucher.count({ where });
    return {
      rows,
      summary: [
        { label: "Journals", value: vouchers, type: "number" },
        { label: "Lines", value: rows.length, type: "number" },
        { label: "Total Debit", value: roundMoney(sumBy(rows, "debit")), type: "money" },
        { label: "Total Credit", value: roundMoney(sumBy(rows, "credit")), type: "money" },
      ],
    };
  },
};

const dayBook = {
  key: "day-book",
  name: "Day Book",
  group: "Accounts",
  description: "Every voucher of the period with its ledger lines — receipts, payments and journals in date order.",
  orientation: "landscape",
  defaultPeriod: "TODAY",
  filters: [
    {
      name: "voucherType",
      label: "Voucher Type",
      type: "select",
      default: "ALL",
      options: [
        { value: "ALL", label: "All" },
        { value: "RECEIPT", label: "Receipt" },
        { value: "PAYMENT", label: "Payment" },
        { value: "JOURNAL", label: "Journal" },
      ],
    },
    INCLUDE_LEGACY_FILTER(true),
    SEARCH_FILTER("Voucher / party / narration"),
  ],
  columns: [
    { key: "date", label: "Date", type: "date" },
    { key: "voucherNo", label: "Voucher No", type: "text" },
    { key: "type", label: "Type", type: "text" },
    { key: "account", label: "Account", type: "text" },
    { key: "particulars", label: "Particulars", type: "text" },
    { key: "debit", label: "Debit", type: "money", total: true },
    { key: "credit", label: "Credit", type: "money", total: true },
  ],
  query: async (storeId, range, filters) => {
    const where = voucherWhere(storeId, range, { ...filters, status: "COMPLETED" }, filters.voucherType !== "ALL" ? { voucherType: filters.voucherType } : {});
    const [rows, counts] = await Promise.all([
      entryRows(storeId, where, "COMPLETED"),
      prisma.voucher.groupBy({ by: ["voucherType"], where, _count: { _all: true } }),
    ]);
    markContinuation(rows);
    const c = Object.fromEntries(counts.map((x) => [x.voucherType, x._count._all]));
    return {
      rows,
      summary: [
        { label: "Vouchers", value: (c.RECEIPT || 0) + (c.PAYMENT || 0) + (c.JOURNAL || 0), type: "number" },
        { label: "Receipts", value: c.RECEIPT || 0, type: "number" },
        { label: "Payments", value: c.PAYMENT || 0, type: "number" },
        { label: "Journals", value: c.JOURNAL || 0, type: "number" },
        { label: "Total Debit", value: roundMoney(sumBy(rows, "debit")), type: "money" },
        { label: "Total Credit", value: roundMoney(sumBy(rows, "credit")), type: "money" },
      ],
    };
  },
};

// ---------------------------------------------------------------- cash book
const CASH_GROUPS = ["Cash", "Cash In Hand", "Cash-in-Hand", "Cash in Hand"];
const cashAccounts = (storeId) =>
  prisma.account.findMany({
    where: {
      storeId,
      OR: [
        ...CASH_GROUPS.map((g) => ({ accountGroup: { equals: g, mode: "insensitive" } })),
        { accountName: { equals: "Cash in Hand", mode: "insensitive" } },
        { accountName: { startsWith: "Cash Counter", mode: "insensitive" } },
      ],
    },
    select: { id: true, accountName: true, openingBalance: true },
  });

const legacyVoucher = { referenceType: { in: LEGACY_REF_TYPES } };

const cashBook = {
  key: "cash-book",
  name: "Cash Book",
  group: "Accounts",
  description: "Cash receipts and payments with opening balance, running balance and closing cash in hand.",
  orientation: "landscape",
  defaultPeriod: "THIS_MONTH",
  filters: [INCLUDE_LEGACY_FILTER(false)],
  columns: [
    { key: "date", label: "Date", type: "date" },
    { key: "voucherNo", label: "Voucher No", type: "text" },
    { key: "type", label: "Type", type: "text" },
    { key: "particulars", label: "Particulars", type: "text" },
    { key: "account", label: "Cash Account", type: "text", pdf: false },
    { key: "receipt", label: "Receipts (Dr)", type: "money", total: true },
    { key: "payment", label: "Payments (Cr)", type: "money", total: true },
    { key: "balance", label: "Balance", type: "money" },
  ],
  query: async (storeId, range, filters) => {
    const accounts = await cashAccounts(storeId);
    const ids = accounts.map((a) => a.id);
    const openingBase = accounts.reduce((s, a) => s + n(a.openingBalance), 0);
    const live = { storeId, accountId: { in: ids }, status: "COMPLETED" };
    const sumOf = async (voucherCond) => {
      const a = await prisma.ledgerEntry.aggregate({ where: { ...live, voucher: { is: { status: "COMPLETED", ...voucherCond } } }, _sum: { debit: true, credit: true } });
      return n(a._sum.debit) - n(a._sum.credit);
    };
    // Migrated balances already include every legacy movement (openingBalance = balance at migration).
    const before = ids.length ? await sumOf({ date: { lt: range.from }, ...nonLegacyVoucher }) : 0;
    const legacyAfterFrom = ids.length && filters.includeLegacy ? await sumOf({ date: { gte: range.from }, ...legacyVoucher }) : 0;
    const opening = roundMoney(openingBase + before - legacyAfterFrom);

    const entries = ids.length
      ? await prisma.ledgerEntry.findMany({
          where: { ...live, voucher: { is: { status: "COMPLETED", date: { gte: range.from, lte: range.to }, ...(filters.includeLegacy ? {} : nonLegacyVoucher) } } },
          select: {
            id: true,
            accountName: true,
            debit: true,
            credit: true,
            narration: true,
            voucher: { select: { voucherNo: true, voucherType: true, date: true, referenceType: true, referenceDocNo: true, partyName: true, narration: true } },
          },
          orderBy: [{ voucher: { date: "asc" } }, { voucherId: "asc" }, { id: "asc" }],
        })
      : [];
    let bal = opening;
    const rows = [{ _kind: "subtotal", _label: "Opening Balance", date: range.period === "ALL" ? null : dateKey(range.from), balance: opening }];
    for (const e of entries) {
      const { dr, cr } = drCr(e);
      bal += dr - cr;
      const v = e.voucher;
      rows.push({
        date: dateKey(v.date),
        voucherNo: v.voucherNo,
        type: isLegacyRef(v.referenceType) ? `${titleCase(v.voucherType)} (legacy)` : titleCase(v.voucherType),
        particulars: [v.partyName, v.narration || e.narration].filter(Boolean).join(" — ") || referenceLabel(v.referenceType, v.referenceDocNo),
        account: e.accountName,
        receipt: roundMoney(dr),
        payment: roundMoney(cr),
        balance: roundMoney(bal),
      });
    }
    const receipts = roundMoney(sumBy(rows, "receipt"));
    const payments = roundMoney(sumBy(rows, "payment"));
    const closing = roundMoney(opening + receipts - payments);
    rows.push({ _kind: "subtotal", _label: "Closing Balance", _strong: true, date: dateKey(range.period === "ALL" ? new Date() : range.to < new Date() ? range.to : new Date()), balance: closing });
    const notes = [];
    if (!accounts.length) notes.push("No cash account found for this store.");
    if (filters.includeLegacy && opening < 0) {
      notes.push("The opening balance is worked back from the balance carried over at migration; it is negative because the old software's cash vouchers were not all migrated.");
    }
    notes.push(
      filters.includeLegacy
        ? "Migrated (legacy) cash entries are listed; the opening balance excludes them so the closing balance still agrees with the ledger."
        : "Migrated (legacy) vouchers are already part of the opening balance and are not listed. Turn on “Include migrated vouchers” to see them."
    );
    return {
      rows,
      totals: { receipt: receipts, payment: payments, balance: closing },
      summary: [
        { label: "Opening Cash", value: opening, type: "money" },
        { label: "Cash Received", value: receipts, type: "money" },
        { label: "Cash Paid", value: payments, type: "money" },
        { label: "Closing Cash", value: closing, type: "money" },
        { label: "Entries", value: entries.length, type: "number" },
      ],
      notes,
    };
  },
};

// ---------------------------------------------------------------- trial balance
const TYPE_ORDER = { ASSET: 0, LIABILITY: 1, CAPITAL: 2, EQUITY: 2, INCOME: 3, EXPENSE: 4 };

const trialBalance = {
  key: "trial-balance",
  name: "Trial Balance",
  group: "Accounts",
  description: "Closing debit / credit balance of every ledger account, grouped by account group.",
  orientation: "portrait",
  period: "none",
  filters: [{ name: "showZero", label: "Show zero-balance accounts", type: "boolean", default: false }],
  columns: [
    { key: "account", label: "Account", type: "text" },
    { key: "group", label: "Group", type: "text", pdf: false },
    { key: "type", label: "Type", type: "text" },
    { key: "debit", label: "Debit", type: "money", total: true },
    { key: "credit", label: "Credit", type: "money", total: true },
  ],
  query: async (storeId, _range, filters) => {
    const accounts = await prisma.account.findMany({
      where: { storeId },
      select: { accountName: true, accountGroup: true, accountType: true, currentBalance: true },
      orderBy: [{ accountGroup: "asc" }, { accountName: "asc" }],
    });
    const groups = new Map();
    for (const a of accounts) {
      const bal = roundMoney(a.currentBalance);
      if (!filters.showZero && Math.abs(bal) < 0.005) continue;
      const g = a.accountGroup || "General";
      if (!groups.has(g)) groups.set(g, { type: a.accountType, list: [] });
      groups.get(g).list.push({ account: a.accountName, group: g, type: titleCase(a.accountType), debit: bal > 0 ? bal : 0, credit: bal < 0 ? -bal : 0 });
    }
    const rows = [];
    const ordered = [...groups.entries()].sort((a, b) => (TYPE_ORDER[a[1].type] ?? 9) - (TYPE_ORDER[b[1].type] ?? 9) || a[0].localeCompare(b[0]));
    let dr = 0;
    let cr = 0;
    for (const [g, { list }] of ordered) {
      rows.push({ _kind: "group", _label: g, account: g });
      for (const r of list) rows.push(r);
      const gd = roundMoney(sumBy(list, "debit"));
      const gc = roundMoney(sumBy(list, "credit"));
      dr += gd;
      cr += gc;
      if (list.length > 1) rows.push({ _kind: "subtotal", _label: `${g} total`, debit: gd, credit: gc });
    }
    dr = roundMoney(dr);
    cr = roundMoney(cr);
    const diff = roundMoney(dr - cr);
    const notes = [];
    if (Math.abs(diff) >= 0.01) {
      rows.push({
        _kind: "subtotal",
        _label: "Difference in opening balances",
        _warn: true,
        account: "Difference in opening balances",
        debit: diff < 0 ? -diff : 0,
        credit: diff > 0 ? diff : 0,
      });
      notes.push(
        `The ledger does not balance by ${formatMoney(Math.abs(diff))}. This difference comes from the opening balances migrated from the old software (legacy ledgers were carried over as single-sided balances) — it is shown on the ${diff > 0 ? "credit" : "debit"} side so the totals agree. Post an opening-balance journal to clear it.`
      );
    }
    return {
      rows,
      totals: { debit: roundMoney(Math.max(dr, cr)), credit: roundMoney(Math.max(dr, cr)) },
      summary: [
        { label: "Accounts", value: rows.filter((r) => !r._kind).length, type: "number" },
        { label: "Total Debit", value: dr, type: "money" },
        { label: "Total Credit", value: cr, type: "money" },
        { label: "Difference", value: Math.abs(diff), type: "money" },
      ],
      notes,
    };
  },
};

export default [voucherRegister("RECEIPT"), voucherRegister("PAYMENT"), journalRegister, dayBook, cashBook, trialBalance];
