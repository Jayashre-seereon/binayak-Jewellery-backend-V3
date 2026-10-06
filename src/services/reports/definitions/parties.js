// Customer / supplier money: advances, outstanding with ageing, collections by payment mode.
import prisma from "../../../config/db.js";
import { roundMoney } from "../../../utils/validate.js";
import { n, dateKey, sumBy, phone10 } from "../engine.js";
import { istMonthKey } from "../theme.js";
import { invoiceValueOf } from "./sales.js";
import { partyNameOf, partyPhoneOf } from "./purchase.js";
import {
  SEARCH_FILTER,
  PURCHASE_TYPE_FILTER,
  PURCHASE_TYPE_LABEL,
  GROUP_BY_PERIOD_FILTER,
  contains,
  dateRangeWhere,
  titleCase,
  ageBucket,
  normaliseMode,
} from "./common.js";

const DAY = 86400000;

// ---------------------------------------------------------------- advance register
const advanceRegister = {
  key: "advance-register",
  name: "Advance Register",
  group: "Sales",
  description: "Every advance received from customers, how much has been used against completed sales, and the balance left.",
  orientation: "landscape",
  defaultPeriod: "THIS_MONTH",
  filters: [
    {
      name: "status",
      label: "Status",
      type: "select",
      default: "ALL",
      options: [
        { value: "ALL", label: "All" },
        { value: "OPEN", label: "Balance available" },
        { value: "AVAILABLE", label: "Available" },
        { value: "PARTIALLY_ADJUSTED", label: "Partially adjusted" },
        { value: "FULLY_ADJUSTED", label: "Fully adjusted" },
        { value: "CANCELLED", label: "Cancelled" },
      ],
    },
    SEARCH_FILTER("Customer / phone"),
  ],
  columns: [
    { key: "date", label: "Date", type: "date" },
    { key: "receiptNo", label: "Advance No", type: "text" },
    { key: "customer", label: "Customer", type: "text" },
    { key: "phone", label: "Phone", type: "text" },
    { key: "mode", label: "Mode", type: "text" },
    { key: "specification", label: "Specification", type: "text", pdf: false },
    { key: "amount", label: "Amount", type: "money", total: true },
    { key: "used", label: "Used in Sales", type: "money", total: true },
    { key: "balance", label: "Balance", type: "money", total: true },
    { key: "status", label: "Status", type: "text" },
  ],
  query: async (storeId, range, filters) => {
    const where = { storeId };
    const d = dateRangeWhere(range);
    if (d) where.receiveDate = d;
    if (filters.status && !["ALL", "OPEN"].includes(filters.status)) where.status = filters.status;
    if (filters.search) where.OR = [{ customerName: contains(filters.search) }, { contactNumber: { contains: filters.search } }];
    const [advances, usage] = await Promise.all([
      prisma.advanceReceive.findMany({
        where,
        select: { id: true, receiveDate: true, customerName: true, contactNumber: true, paymentMode: true, specification: true, amount: true, balanceAmount: true, status: true },
        orderBy: [{ receiveDate: "asc" }, { id: "asc" }],
      }),
      prisma.saleAdvanceAdjustment.groupBy({
        by: ["advanceReceiveId"],
        where: { storeId, sale: { is: { status: "COMPLETED" } }, advanceReceive: { is: where } },
        _sum: { amount: true },
      }),
    ]);
    const used = new Map(usage.map((u) => [u.advanceReceiveId, n(u._sum.amount)]));
    let rows = advances.map((a) => {
      const amount = roundMoney(a.amount);
      const u = roundMoney(used.get(a.id) || 0);
      const unusable = ["CANCELLED", "FULLY_ADJUSTED", "ADJUSTED"].includes(String(a.status).toUpperCase());
      const balance = unusable ? 0 : roundMoney(Math.max(0, Math.min(n(a.balanceAmount), amount - u)));
      return {
        date: dateKey(a.receiveDate),
        receiptNo: `ADV-${a.id}`,
        customer: a.customerName,
        phone: String(a.contactNumber || "").replace(/\D/g, "").length >= 5 ? a.contactNumber : "",
        mode: titleCase(a.paymentMode),
        specification: a.specification || "",
        amount,
        used: u,
        balance,
        status: titleCase(a.status),
      };
    });
    if (filters.status === "OPEN") rows = rows.filter((r) => r.balance > 0.009);
    const summary = [
      { label: "Advances", value: rows.length, type: "number" },
      { label: "Received", value: roundMoney(sumBy(rows, "amount")), type: "money" },
      { label: "Used in Sales", value: roundMoney(sumBy(rows, "used")), type: "money" },
      { label: "Balance Held", value: roundMoney(sumBy(rows, "balance")), type: "money" },
      { label: "Open Advances", value: rows.filter((r) => r.balance > 0.009).length, type: "number" },
    ];
    return { rows, summary };
  },
};

// ---------------------------------------------------------------- outstanding with ageing
const VIEW_FILTER = (label) => ({
  name: "view",
  label: "View",
  type: "select",
  default: "PARTY",
  options: [
    { value: "PARTY", label: `${label}-wise` },
    { value: "INVOICE", label: "Invoice-wise" },
  ],
});

const AGE_COLUMNS = [
  { key: "b0", label: "0–30 days", type: "money", total: true },
  { key: "b31", label: "31–60 days", type: "money", total: true },
  { key: "b61", label: "61–90 days", type: "money", total: true },
  { key: "b90", label: "90+ days", type: "money", total: true },
];

const asOfDate = (range) => {
  const now = new Date();
  return range && range.to < now ? range.to : now;
};

/** docs: [{ key, name, phone, date, docNo, value, paid, due }] → party rows or invoice rows with ageing. */
const ageRows = (docs, view, asOf) => {
  const withAge = docs.map((d) => {
    const days = Math.max(0, Math.floor((asOf - d.date) / DAY));
    return { ...d, days, bucket: ageBucket(days) };
  });
  if (view === "INVOICE") {
    return withAge
      .sort((a, b) => a.date - b.date)
      .map((d) => ({
        date: dateKey(d.date),
        docNo: d.docNo,
        party: d.name,
        phone: d.phone,
        value: roundMoney(d.value),
        paid: roundMoney(d.paid),
        due: roundMoney(d.due),
        days: d.days,
        b0: d.bucket === "b0" ? roundMoney(d.due) : 0,
        b31: d.bucket === "b31" ? roundMoney(d.due) : 0,
        b61: d.bucket === "b61" ? roundMoney(d.due) : 0,
        b90: d.bucket === "b90" ? roundMoney(d.due) : 0,
      }));
  }
  const parties = new Map();
  for (const d of withAge) {
    const p = parties.get(d.key) || { party: d.name, phone: d.phone, docs: 0, oldest: d.date, b0: 0, b31: 0, b61: 0, b90: 0, due: 0 };
    p.docs += 1;
    if (d.date < p.oldest) p.oldest = d.date;
    p[d.bucket] += d.due;
    p.due += d.due;
    parties.set(d.key, p);
  }
  return [...parties.values()]
    .sort((a, b) => b.due - a.due)
    .map((p) => ({
      party: p.party,
      phone: p.phone,
      docs: p.docs,
      oldest: dateKey(p.oldest),
      days: Math.max(0, Math.floor((asOf - p.oldest) / DAY)),
      b0: roundMoney(p.b0),
      b31: roundMoney(p.b31),
      b61: roundMoney(p.b61),
      b90: roundMoney(p.b90),
      due: roundMoney(p.due),
    }));
};

const outstandingColumns = (partyLabel, docLabel) => (f) =>
  f.view === "INVOICE"
    ? [
        { key: "date", label: "Date", type: "date" },
        { key: "docNo", label: docLabel, type: "text" },
        { key: "party", label: partyLabel, type: "text" },
        { key: "phone", label: "Phone", type: "text" },
        { key: "value", label: "Bill Value", type: "money", total: true },
        { key: "paid", label: "Paid", type: "money", total: true },
        { key: "days", label: "Age (days)", type: "number", align: "center" },
        ...AGE_COLUMNS,
        { key: "due", label: "Outstanding", type: "money", total: true },
      ]
    : [
        { key: "party", label: partyLabel, type: "text" },
        { key: "phone", label: "Phone", type: "text" },
        { key: "docs", label: "Bills", type: "number", total: true, align: "center" },
        { key: "oldest", label: "Oldest Bill", type: "date" },
        { key: "days", label: "Age (days)", type: "number", align: "center" },
        ...AGE_COLUMNS,
        { key: "due", label: "Outstanding", type: "money", total: true },
      ];

const ageSummary = (rows, countLabel, count) => [
  { label: countLabel, value: count, type: "number" },
  { label: "Total Outstanding", value: roundMoney(sumBy(rows, "due")), type: "money" },
  { label: "0–30 days", value: roundMoney(sumBy(rows, "b0")), type: "money" },
  { label: "31–60 days", value: roundMoney(sumBy(rows, "b31")), type: "money" },
  { label: "61–90 days", value: roundMoney(sumBy(rows, "b61")), type: "money" },
  { label: "90+ days", value: roundMoney(sumBy(rows, "b90")), type: "money" },
];

const customerOutstanding = {
  key: "customer-outstanding",
  name: "Customer Outstanding",
  group: "Accounts",
  description: "Unpaid sale invoices by customer with ageing (0–30, 31–60, 61–90, 90+ days).",
  orientation: "landscape",
  defaultPeriod: "ALL",
  filters: [VIEW_FILTER("Customer"), SEARCH_FILTER("Customer / phone / invoice")],
  columns: outstandingColumns("Customer", "Invoice No"),
  query: async (storeId, range, filters) => {
    const where = { storeId, status: "COMPLETED", dueAmount: { gt: 0.009 } };
    const d = dateRangeWhere(range);
    if (d) where.saleDate = d;
    if (filters.search) where.OR = [{ invoiceNo: contains(filters.search) }, { customerName: contains(filters.search) }, { customerPhone: { contains: filters.search } }];
    const sales = await prisma.sale.findMany({
      where,
      select: { id: true, invoiceNo: true, saleDate: true, customerId: true, customerName: true, customerPhone: true, subTotal: true, roundOff: true, netPayable: true, paidAmount: true, dueAmount: true },
    });
    const docs = sales.map((s) => {
      const ph = phone10(s.customerPhone);
      const name = s.customerName || "Walk-in";
      return {
        key: s.customerId ? `c${s.customerId}` : ph ? `p${ph}` : `n${name.trim().toUpperCase()}`,
        name,
        phone: ph,
        date: s.saleDate,
        docNo: s.invoiceNo,
        value: invoiceValueOf(s),
        paid: n(s.paidAmount),
        due: n(s.dueAmount),
      };
    });
    const rows = ageRows(docs, filters.view, asOfDate(range));
    const parties = new Set(docs.map((x) => x.key)).size;
    return { rows, summary: ageSummary(rows, filters.view === "INVOICE" ? "Invoices" : "Customers", filters.view === "INVOICE" ? rows.length : parties) };
  },
};

const supplierOutstanding = {
  key: "supplier-outstanding",
  name: "Supplier Outstanding",
  group: "Accounts",
  description: "Amounts still owed on purchase bills (suppliers and old-gold sellers) with ageing.",
  orientation: "landscape",
  defaultPeriod: "ALL",
  filters: [VIEW_FILTER("Party"), PURCHASE_TYPE_FILTER, SEARCH_FILTER("Party / phone / invoice")],
  columns: (f) => {
    const cols = outstandingColumns("Party / Supplier", "Invoice No")(f);
    if (f.view === "INVOICE") cols.splice(3, 0, { key: "type", label: "Type", type: "text" });
    return cols;
  },
  query: async (storeId, range, filters) => {
    const where = { storeId, dueAmount: { gt: 0.009 } };
    const d = dateRangeWhere(range);
    if (d) where.date = d;
    if (filters.purchaseType !== "ALL") where.purchaseType = filters.purchaseType;
    if (filters.search) {
      where.OR = [
        { invoiceNo: contains(filters.search) },
        { customerName: contains(filters.search) },
        { customerPhone: { contains: filters.search } },
        { party: { is: { name: contains(filters.search) } } },
      ];
    }
    const purchases = await prisma.purchase.findMany({
      where,
      select: { id: true, invoiceNo: true, date: true, purchaseType: true, partyId: true, customerId: true, customerName: true, customerPhone: true, party: { select: { name: true, phone: true } }, netPayable: true, totalAmount: true, paidAmount: true, dueAmount: true },
    });
    const types = new Map();
    const docs = purchases.map((p) => {
      const ph = phone10(partyPhoneOf(p));
      const name = partyNameOf(p);
      types.set(p.invoiceNo, PURCHASE_TYPE_LABEL[p.purchaseType] || p.purchaseType);
      return {
        key: p.partyId ? `s${p.partyId}` : p.customerId ? `c${p.customerId}` : ph ? `p${ph}` : `n${name.trim().toUpperCase()}`,
        name,
        phone: ph,
        date: p.date,
        docNo: p.invoiceNo || `#${p.id}`,
        value: n(p.netPayable) || n(p.totalAmount),
        paid: n(p.paidAmount),
        due: n(p.dueAmount),
      };
    });
    let rows = ageRows(docs, filters.view, asOfDate(range));
    if (filters.view === "INVOICE") rows = rows.map((r) => ({ ...r, type: types.get(r.docNo) || "" }));
    const parties = new Set(docs.map((x) => x.key)).size;
    return { rows, summary: ageSummary(rows, filters.view === "INVOICE" ? "Bills" : "Parties", filters.view === "INVOICE" ? rows.length : parties) };
  },
};

// ---------------------------------------------------------------- payment-mode collection
const MODES = ["CASH", "UPI", "CARD", "ONLINE", "CHEQUE", "OTHER"];

const paymentCollection = {
  key: "payment-collection",
  name: "Payment-mode Collection",
  group: "Accounts",
  description: "Money collected per day by mode — counter payments on completed sales plus receipt vouchers (advances, dues, other).",
  orientation: "landscape",
  defaultPeriod: "THIS_MONTH",
  filters: [GROUP_BY_PERIOD_FILTER],
  columns: (f) => [
    { key: "date", label: f.groupBy === "MONTH" ? "Month" : "Date", type: "date" },
    { key: "count", label: "Txns", type: "number", total: true, align: "center" },
    { key: "CASH", label: "Cash", type: "money", total: true },
    { key: "UPI", label: "UPI", type: "money", total: true },
    { key: "CARD", label: "Card", type: "money", total: true },
    { key: "ONLINE", label: "Online / Bank", type: "money", total: true },
    { key: "CHEQUE", label: "Cheque", type: "money", total: true },
    { key: "OTHER", label: "Other", type: "money", total: true },
    { key: "sales", label: "From Sales", type: "money", total: true, pdf: false },
    { key: "receipts", label: "Other Receipts", type: "money", total: true, pdf: false },
    { key: "total", label: "Total", type: "money", total: true },
  ],
  query: async (storeId, range, filters) => {
    const d = dateRangeWhere(range);
    const [payments, receipts] = await Promise.all([
      prisma.salePayment.findMany({
        where: { storeId, ...(d ? { paymentDate: d } : {}), sale: { is: { status: "COMPLETED" } } },
        select: { paymentDate: true, paymentMode: true, amount: true, voucherId: true },
      }),
      // Receipt vouchers that are not already represented by a SalePayment row. Migrated
      // retail-invoice receipts mirror the migrated sale payments, so they are skipped too.
      prisma.voucher.findMany({
        where: {
          storeId,
          voucherType: "RECEIPT",
          status: "COMPLETED",
          ...(d ? { date: d } : {}),
          NOT: { referenceType: "RetailInvoice" },
        },
        select: { id: true, date: true, amount: true, paymentMode: true, referenceType: true },
      }),
    ]);
    const unknownMode = receipts.filter((v) => !v.paymentMode).map((v) => v.id);
    const debitSide = new Map();
    if (unknownMode.length) {
      const lines = await prisma.ledgerEntry.findMany({ where: { storeId, voucherId: { in: unknownMode }, debit: { gt: 0 } }, select: { voucherId: true, accountName: true, debit: true } });
      const best = new Map();
      for (const l of lines) {
        if (Number(l.debit) > (best.get(l.voucherId) || 0)) {
          best.set(l.voucherId, Number(l.debit));
          debitSide.set(l.voucherId, l.accountName);
        }
      }
    }
    const linked = new Set(payments.filter((p) => p.voucherId).map((p) => p.voucherId));
    const key = (dt) => (filters.groupBy === "MONTH" ? istMonthKey(dt) : dateKey(dt));
    const buckets = new Map();
    const add = (dt, mode, amount, source) => {
      const k = key(dt);
      const b = buckets.get(k) || { date: k, count: 0, CASH: 0, UPI: 0, CARD: 0, ONLINE: 0, CHEQUE: 0, OTHER: 0, sales: 0, receipts: 0, total: 0 };
      b.count += 1;
      b[mode] += amount;
      b[source] += amount;
      b.total += amount;
      buckets.set(k, b);
    };
    for (const p of payments) add(p.paymentDate, normaliseMode(p.paymentMode), n(p.amount), "sales");
    for (const v of receipts) {
      if (linked.has(v.id)) continue;
      add(v.date, normaliseMode(v.paymentMode, debitSide.get(v.id)), n(v.amount), "receipts");
    }
    const rows = [...buckets.values()]
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((b) => ({ ...b, ...Object.fromEntries([...MODES, "sales", "receipts", "total"].map((m) => [m, roundMoney(b[m])])) }));
    const summary = [
      { label: "Total Collected", value: roundMoney(sumBy(rows, "total")), type: "money" },
      { label: "Cash", value: roundMoney(sumBy(rows, "CASH")), type: "money" },
      { label: "UPI", value: roundMoney(sumBy(rows, "UPI")), type: "money" },
      { label: "Card", value: roundMoney(sumBy(rows, "CARD")), type: "money" },
      { label: "Online / Bank", value: roundMoney(sumBy(rows, "ONLINE")), type: "money" },
      { label: "Cheque / Other", value: roundMoney(sumBy(rows, "CHEQUE") + sumBy(rows, "OTHER")), type: "money" },
    ];
    return { rows, summary };
  },
};

export default [advanceRegister, customerOutstanding, supplierOutstanding, paymentCollection];
