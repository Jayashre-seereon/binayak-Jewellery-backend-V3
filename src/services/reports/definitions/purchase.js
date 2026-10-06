import prisma from "../../../config/db.js";
import { roundMoney, roundWeight } from "../../../utils/validate.js";
import { n, dateKey, sumBy } from "../engine.js";
import { PURCHASE_TYPE_FILTER, PURCHASE_TYPE_LABEL, SEARCH_FILTER, contains, dateRangeWhere, pureOf, titleCase } from "./common.js";

export const purchaseWhere = (storeId, range, filters = {}) => {
  const where = { storeId };
  const d = dateRangeWhere(range);
  if (d) where.date = d;
  if (filters.purchaseType && filters.purchaseType !== "ALL") where.purchaseType = filters.purchaseType;
  if (!filters.includeOpeningStock) where.isOpeningStock = false;
  if (filters.search) {
    where.OR = [
      { invoiceNo: contains(filters.search) },
      { referenceNo: contains(filters.search) },
      { customerName: contains(filters.search) },
      { customerPhone: { contains: filters.search } },
      { party: { is: { name: contains(filters.search) } } },
    ];
  }
  return where;
};

const PURCHASE_SELECT = {
  id: true,
  invoiceNo: true,
  referenceNo: true,
  date: true,
  purchaseType: true,
  isOpeningStock: true,
  isRCM: true,
  customerName: true,
  customerPhone: true,
  party: { select: { name: true, phone: true } },
  grossAmount: true,
  taxableAmount: true,
  discount: true,
  cgst: true,
  sgst: true,
  igst: true,
  taxAmount: true,
  roundOff: true,
  netPayable: true,
  totalAmount: true,
  paidAmount: true,
  dueAmount: true,
  adjustedAmount: true,
  balanceAmount: true,
  adjustmentStatus: true,
};

/** pieces / gross / net / pure weight per purchase (one query, aggregated in memory). */
const purchaseWeights = async (where) => {
  const items = await prisma.purchaseItem.findMany({
    where: { purchase: { is: where } },
    select: { purchaseId: true, pieces: true, grossWeight: true, netWeight: true, pureWeight: true, purity: true },
  });
  const map = new Map();
  for (const it of items) {
    const g = map.get(it.purchaseId) || { pieces: 0, grossWeight: 0, netWeight: 0, pureWeight: 0 };
    g.pieces += it.pieces ?? 1;
    g.grossWeight += n(it.grossWeight);
    g.netWeight += n(it.netWeight);
    g.pureWeight += pureOf(it.pureWeight, it.netWeight, it.purity);
    map.set(it.purchaseId, g);
  }
  return map;
};

export const partyNameOf = (p) => p.party?.name || p.customerName || "—";
export const partyPhoneOf = (p) => p.party?.phone || (p.customerPhone && p.customerPhone !== "0" ? p.customerPhone : "");

export const purchaseRow = (p, w = {}) => ({
  date: dateKey(p.date),
  invoiceNo: p.invoiceNo || "—",
  referenceNo: p.referenceNo || "",
  type: p.isOpeningStock ? "Opening Stock" : PURCHASE_TYPE_LABEL[p.purchaseType] || p.purchaseType,
  party: partyNameOf(p),
  phone: partyPhoneOf(p),
  pieces: w.pieces || 0,
  grossWeight: roundWeight(w.grossWeight || 0),
  netWeight: roundWeight(w.netWeight || 0),
  pureWeight: roundWeight(w.pureWeight || 0),
  taxable: roundMoney(n(p.taxableAmount) || n(p.grossAmount)),
  cgst: roundMoney(p.cgst),
  sgst: roundMoney(p.sgst),
  igst: roundMoney(p.igst),
  gst: roundMoney(n(p.taxAmount) || n(p.cgst) + n(p.sgst) + n(p.igst)),
  rcm: p.isRCM ? "Yes" : "",
  netAmount: roundMoney(n(p.netPayable) || n(p.totalAmount)),
  paid: roundMoney(p.paidAmount),
  adjusted: roundMoney(p.adjustedAmount),
  due: roundMoney(p.dueAmount),
  status: titleCase(p.adjustmentStatus),
});

const purchaseRegister = {
  key: "purchase-register",
  name: "Purchase Register",
  group: "Purchase",
  description: "Bill-wise purchases (ornament, bullion and old gold) with weights, GST, payments and amount still owed.",
  orientation: "landscape",
  defaultPeriod: "THIS_MONTH",
  filters: [
    PURCHASE_TYPE_FILTER,
    { name: "includeOpeningStock", label: "Include opening-stock entries", type: "boolean", default: false },
    SEARCH_FILTER("Invoice / party / phone"),
  ],
  columns: [
    { key: "date", label: "Date", type: "date" },
    { key: "invoiceNo", label: "Invoice No", type: "text" },
    { key: "referenceNo", label: "Supplier Bill No", type: "text", pdf: false },
    { key: "type", label: "Type", type: "text" },
    { key: "party", label: "Party / Customer", type: "text" },
    { key: "phone", label: "Phone", type: "text", pdf: false },
    { key: "pieces", label: "Pcs", type: "number", total: true, align: "center" },
    { key: "grossWeight", label: "Gross Wt (g)", type: "weight", total: true },
    { key: "netWeight", label: "Net Wt (g)", type: "weight", total: true },
    { key: "pureWeight", label: "Pure Wt (g)", type: "weight", total: true, pdf: false },
    { key: "taxable", label: "Taxable", type: "money", total: true },
    { key: "cgst", label: "CGST", type: "money", total: true, pdf: false },
    { key: "sgst", label: "SGST", type: "money", total: true, pdf: false },
    { key: "igst", label: "IGST", type: "money", total: true, pdf: false },
    { key: "gst", label: "GST", type: "money", total: true },
    { key: "rcm", label: "RCM", type: "text", pdf: false },
    { key: "netAmount", label: "Net Amount", type: "money", total: true },
    { key: "paid", label: "Paid", type: "money", total: true },
    { key: "due", label: "Due", type: "money", total: true },
  ],
  query: async (storeId, range, filters) => {
    const where = purchaseWhere(storeId, range, filters);
    const [purchases, weights] = await Promise.all([
      prisma.purchase.findMany({ where, select: PURCHASE_SELECT, orderBy: [{ date: "asc" }, { id: "asc" }] }),
      purchaseWeights(where),
    ]);
    const rows = purchases.map((p) => purchaseRow(p, weights.get(p.id)));
    const summary = [
      { label: "Bills", value: rows.length, type: "number" },
      { label: "Net Purchase", value: roundMoney(sumBy(rows, "netAmount")), type: "money" },
      { label: "GST", value: roundMoney(sumBy(rows, "gst")), type: "money" },
      { label: "Net Weight (g)", value: roundWeight(sumBy(rows, "netWeight")), type: "weight" },
      { label: "Paid", value: roundMoney(sumBy(rows, "paid")), type: "money" },
      { label: "Amount Owed", value: roundMoney(sumBy(rows, "due")), type: "money" },
    ];
    return { rows, summary };
  },
};

const oldPurchaseRegister = {
  key: "old-purchase-register",
  name: "Old Gold / URD Purchase Register",
  group: "Purchase",
  description: "Old gold bought from customers: weights, value, cash paid, value adjusted against sales and balance.",
  orientation: "landscape",
  defaultPeriod: "THIS_MONTH",
  filters: [
    {
      name: "adjustment",
      label: "Adjustment",
      type: "select",
      default: "ALL",
      options: [
        { value: "ALL", label: "All" },
        { value: "OPEN", label: "Balance available" },
        { value: "SETTLED", label: "Settled / fully adjusted" },
      ],
    },
    SEARCH_FILTER("Invoice / customer / phone"),
  ],
  columns: [
    { key: "date", label: "Date", type: "date" },
    { key: "invoiceNo", label: "Invoice No", type: "text" },
    { key: "party", label: "Customer", type: "text" },
    { key: "phone", label: "Phone", type: "text" },
    { key: "pieces", label: "Pcs", type: "number", total: true, align: "center" },
    { key: "grossWeight", label: "Gross Wt (g)", type: "weight", total: true },
    { key: "netWeight", label: "Net Wt (g)", type: "weight", total: true },
    { key: "pureWeight", label: "Pure Wt (g)", type: "weight", total: true },
    { key: "netAmount", label: "Value", type: "money", total: true },
    { key: "paid", label: "Paid", type: "money", total: true },
    { key: "adjusted", label: "Adjusted in Sales", type: "money", total: true },
    { key: "due", label: "Balance", type: "money", total: true },
    { key: "status", label: "Status", type: "text" },
  ],
  query: async (storeId, range, filters) => {
    const where = purchaseWhere(storeId, range, { purchaseType: "OLD", search: filters.search });
    if (filters.adjustment === "OPEN") where.dueAmount = { gt: 0.009 };
    if (filters.adjustment === "SETTLED") where.dueAmount = { lte: 0.009 };
    const [purchases, weights] = await Promise.all([
      prisma.purchase.findMany({ where, select: PURCHASE_SELECT, orderBy: [{ date: "asc" }, { id: "asc" }] }),
      purchaseWeights(where),
    ]);
    const rows = purchases.map((p) => purchaseRow(p, weights.get(p.id)));
    const summary = [
      { label: "Purchases", value: rows.length, type: "number" },
      { label: "Pure Weight (g)", value: roundWeight(sumBy(rows, "pureWeight")), type: "weight" },
      { label: "Total Value", value: roundMoney(sumBy(rows, "netAmount")), type: "money" },
      { label: "Paid in Cash/Bank", value: roundMoney(sumBy(rows, "paid")), type: "money" },
      { label: "Adjusted in Sales", value: roundMoney(sumBy(rows, "adjusted")), type: "money" },
      { label: "Balance Available", value: roundMoney(sumBy(rows, "due")), type: "money" },
    ];
    return { rows, summary };
  },
};

export default [purchaseRegister, oldPurchaseRegister];
