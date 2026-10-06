import prisma from "../../../config/db.js";
import { roundMoney, roundWeight } from "../../../utils/validate.js";
import { n, dateKey, sumBy } from "../engine.js";
import { istMonthKey } from "../theme.js";
import {
  SALE_STATUS_FILTER,
  SEARCH_FILTER,
  GROUP_BY_PERIOD_FILTER,
  contains,
  dateRangeWhere,
  MODE_LABEL,
} from "./common.js";

const SALE_SELECT = {
  id: true,
  invoiceNo: true,
  saleDate: true,
  status: true,
  customerName: true,
  customerPhone: true,
  party: { select: { name: true } },
  grossAmount: true,
  discount: true,
  offerDiscount: true,
  taxableAmount: true,
  cgstAmount: true,
  sgstAmount: true,
  igstAmount: true,
  cgst: true,
  sgst: true,
  igst: true,
  totalTax: true,
  taxAmount: true,
  subTotal: true,
  roundOff: true,
  lessUrd: true,
  oldGoldAmount: true,
  advanceAmount: true,
  netPayable: true,
  paidAmount: true,
  dueAmount: true,
};

/** Invoice value = subTotal (+ round off). Migrated sales carry no subTotal: their net payable is the bill value. */
export const invoiceValueOf = (s) => (n(s.subTotal) > 0 ? roundMoney(n(s.subTotal) + n(s.roundOff)) : roundMoney(n(s.netPayable)));
export const taxOf = (s) => {
  const parts = n(s.cgstAmount || s.cgst) + n(s.sgstAmount || s.sgst) + n(s.igstAmount || s.igst);
  return roundMoney(n(s.totalTax) || n(s.taxAmount) || parts);
};

export const saleWhere = (storeId, range, filters = {}) => {
  const where = { storeId };
  const d = dateRangeWhere(range);
  if (d) where.saleDate = d;
  if (filters.status && filters.status !== "ALL") where.status = filters.status;
  if (filters.search) {
    where.OR = [{ invoiceNo: contains(filters.search) }, { customerName: contains(filters.search) }, { customerPhone: { contains: filters.search } }];
  }
  return where;
};

const itemAggregates = async (where) => {
  const groups = await prisma.saleItem.groupBy({
    by: ["saleId"],
    where: { sale: { is: where } },
    _sum: { pieces: true, grossWeight: true, netWeight: true },
    _count: { _all: true },
  });
  const map = new Map();
  for (const g of groups) map.set(g.saleId, { pieces: n(g._sum.pieces) || g._count._all, grossWeight: n(g._sum.grossWeight), netWeight: n(g._sum.netWeight), lines: g._count._all });
  return map;
};

const cancelledCount = (storeId, range) => prisma.sale.count({ where: { ...saleWhere(storeId, range), status: "CANCELLED" } });

export const saleRow = (s, agg = {}) => {
  const cg = n(s.cgstAmount || s.cgst);
  const sg = n(s.sgstAmount || s.sgst);
  const ig = n(s.igstAmount || s.igst);
  return {
    date: dateKey(s.saleDate),
    invoiceNo: s.invoiceNo,
    customer: s.customerName || s.party?.name || "Walk-in",
    phone: s.customerPhone && s.customerPhone !== "0" ? s.customerPhone : "",
    pieces: agg.pieces || 0,
    grossWeight: roundWeight(agg.grossWeight || 0),
    netWeight: roundWeight(agg.netWeight || 0),
    discount: roundMoney(n(s.discount) + n(s.offerDiscount)),
    taxable: roundMoney(n(s.taxableAmount)),
    cgst: roundMoney(cg),
    sgst: roundMoney(sg),
    igst: roundMoney(ig),
    gst: taxOf(s),
    roundOff: roundMoney(n(s.roundOff)),
    invoiceValue: invoiceValueOf(s),
    oldGold: roundMoney(n(s.oldGoldAmount) + n(s.lessUrd)),
    advance: roundMoney(n(s.advanceAmount)),
    netPayable: roundMoney(n(s.netPayable)),
    paid: roundMoney(n(s.paidAmount)),
    due: roundMoney(n(s.dueAmount)),
    status: s.status === "CANCELLED" ? "Cancelled" : "Completed",
  };
};

const salesRegister = {
  key: "sales-register",
  name: "Sales Register",
  group: "Sales",
  description: "Invoice-wise sales with weight, taxable value, GST, exchange/advance adjustments, collections and dues.",
  orientation: "landscape",
  defaultPeriod: "THIS_MONTH",
  filters: [SALE_STATUS_FILTER, SEARCH_FILTER("Invoice / customer / phone")],
  columns: (f) => [
    { key: "date", label: "Date", type: "date" },
    { key: "invoiceNo", label: "Invoice No", type: "text" },
    { key: "customer", label: "Customer", type: "text" },
    { key: "phone", label: "Phone", type: "text" },
    { key: "pieces", label: "Pcs", type: "number", total: true, align: "center" },
    { key: "grossWeight", label: "Gross Wt (g)", type: "weight", total: true, pdf: false },
    { key: "netWeight", label: "Net Wt (g)", type: "weight", total: true },
    { key: "discount", label: "Discount", type: "money", total: true, pdf: false },
    { key: "taxable", label: "Taxable", type: "money", total: true },
    { key: "cgst", label: "CGST", type: "money", total: true, pdf: false },
    { key: "sgst", label: "SGST", type: "money", total: true, pdf: false },
    { key: "igst", label: "IGST", type: "money", total: true, pdf: false },
    { key: "gst", label: "GST", type: "money", total: true },
    { key: "roundOff", label: "Round Off", type: "money", total: true, pdf: false },
    { key: "invoiceValue", label: "Invoice Value", type: "money", total: true },
    { key: "oldGold", label: "Old Gold", type: "money", total: true },
    { key: "advance", label: "Advance", type: "money", total: true },
    { key: "netPayable", label: "Net Payable", type: "money", total: true, pdf: false },
    { key: "paid", label: "Paid", type: "money", total: true },
    { key: "due", label: "Due", type: "money", total: true },
    { key: "modes", label: "Payment Modes", type: "text", pdf: false },
    ...(f.status === "ALL" ? [{ key: "status", label: "Status", type: "text" }] : []),
  ],
  query: async (storeId, range, filters) => {
    const where = saleWhere(storeId, range, filters);
    const [sales, agg, payGroups, cancelled] = await Promise.all([
      prisma.sale.findMany({ where, select: SALE_SELECT, orderBy: [{ saleDate: "asc" }, { id: "asc" }] }),
      itemAggregates(where),
      prisma.salePayment.groupBy({ by: ["saleId", "paymentMode"], where: { storeId, sale: { is: where } }, _sum: { amount: true } }),
      filters.status === "COMPLETED" ? cancelledCount(storeId, range) : Promise.resolve(null),
    ]);
    const modes = new Map();
    for (const p of payGroups) {
      if (!modes.has(p.saleId)) modes.set(p.saleId, []);
      modes.get(p.saleId).push(MODE_LABEL[p.paymentMode === "ONLINE" ? "ONLINE" : p.paymentMode] || p.paymentMode);
    }
    const rows = sales.map((s) => ({ ...saleRow(s, agg.get(s.id)), modes: (modes.get(s.id) || []).join(", ") }));
    const summary = [
      { label: "Invoices", value: rows.length, type: "number" },
      { label: "Invoice Value", value: roundMoney(sumBy(rows, "invoiceValue")), type: "money" },
      { label: "Taxable Value", value: roundMoney(sumBy(rows, "taxable")), type: "money" },
      { label: "GST", value: roundMoney(sumBy(rows, "gst")), type: "money" },
      { label: "Collected", value: roundMoney(sumBy(rows, "paid")), type: "money" },
      { label: "Outstanding", value: roundMoney(sumBy(rows, "due")), type: "money" },
    ];
    if (cancelled !== null) summary.push({ label: "Cancelled (excluded)", value: cancelled, type: "number" });
    return { rows, summary };
  },
};

const salesSummary = {
  key: "sales-summary",
  name: "Sales Summary",
  group: "Sales",
  description: "Day-wise (or month-wise) totals of invoices, weight, taxable value, GST, adjustments and collections.",
  orientation: "landscape",
  defaultPeriod: "THIS_MONTH",
  filters: [GROUP_BY_PERIOD_FILTER],
  columns: (f) => [
    { key: "date", label: f.groupBy === "MONTH" ? "Month" : "Date", type: "date" },
    { key: "invoices", label: "Invoices", type: "number", total: true, align: "center" },
    { key: "pieces", label: "Pieces", type: "number", total: true, align: "center" },
    { key: "netWeight", label: "Net Wt (g)", type: "weight", total: true },
    { key: "taxable", label: "Taxable", type: "money", total: true },
    { key: "gst", label: "GST", type: "money", total: true },
    { key: "invoiceValue", label: "Invoice Value", type: "money", total: true },
    { key: "oldGold", label: "Old Gold", type: "money", total: true },
    { key: "advance", label: "Advance", type: "money", total: true },
    { key: "paid", label: "Collected", type: "money", total: true },
    { key: "due", label: "Due", type: "money", total: true },
  ],
  query: async (storeId, range, filters) => {
    const where = saleWhere(storeId, range, { status: "COMPLETED" });
    const [sales, agg, cancelled] = await Promise.all([
      prisma.sale.findMany({ where, select: SALE_SELECT, orderBy: [{ saleDate: "asc" }, { id: "asc" }] }),
      itemAggregates(where),
      cancelledCount(storeId, range),
    ]);
    const byKey = new Map();
    for (const s of sales) {
      const r = saleRow(s, agg.get(s.id));
      const k = filters.groupBy === "MONTH" ? istMonthKey(s.saleDate) : r.date;
      if (!byKey.has(k)) byKey.set(k, { date: k, invoices: 0, pieces: 0, netWeight: 0, taxable: 0, gst: 0, invoiceValue: 0, oldGold: 0, advance: 0, paid: 0, due: 0 });
      const g = byKey.get(k);
      g.invoices += 1;
      for (const f of ["pieces", "netWeight", "taxable", "gst", "invoiceValue", "oldGold", "advance", "paid", "due"]) g[f] += r[f];
    }
    const rows = [...byKey.values()].map((g) => ({
      ...g,
      netWeight: roundWeight(g.netWeight),
      ...Object.fromEntries(["taxable", "gst", "invoiceValue", "oldGold", "advance", "paid", "due"].map((f) => [f, roundMoney(g[f])])),
    }));
    const best = rows.reduce((b, r) => (!b || r.invoiceValue > b.invoiceValue ? r : b), null);
    const totalValue = roundMoney(sumBy(rows, "invoiceValue"));
    const summary = [
      { label: "Invoices", value: sales.length, type: "number" },
      { label: "Invoice Value", value: totalValue, type: "money" },
      { label: "Net Weight (g)", value: roundWeight(sumBy(rows, "netWeight")), type: "weight" },
      { label: "Collected", value: roundMoney(sumBy(rows, "paid")), type: "money" },
      { label: filters.groupBy === "MONTH" ? "Avg / Month" : "Avg / Day", value: rows.length ? roundMoney(totalValue / rows.length) : 0, type: "money" },
      { label: filters.groupBy === "MONTH" ? "Best Month" : "Best Day", value: best ? best.date : "—", type: "date" },
      { label: "Cancelled (excluded)", value: cancelled, type: "number" },
    ];
    return { rows, summary };
  },
};

export default [salesRegister, salesSummary];
