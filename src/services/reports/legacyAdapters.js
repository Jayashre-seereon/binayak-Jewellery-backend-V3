// Adapters for the existing Sales / Purchase Report exports (/api/sales|purchases/report/export-*):
// their services return full Prisma rows; we map them onto the engine's register columns so
// those files get exactly the same look (and the same column rules) as the new report engine.
import prisma from "../../config/db.js";
import { roundMoney, roundWeight } from "../../utils/validate.js";
import { getDefinition, resolveColumns, computeTotals, sumBy, n } from "./index.js";
import { saleRow } from "./definitions/sales.js";
import { purchaseRow } from "./definitions/purchase.js";
import { pureOf, MODE_LABEL } from "./definitions/common.js";
import { formatDate, istDateKey } from "./theme.js";
import { periodName } from "../../utils/reportDateFilter.js";

const storeSelect = { id: true, storeName: true, location: true, address: true, city: true, state: true, gstNo: true, phone: true, email: true, cinNo: true, tagline: true };

/** Store for the export: the request's (tenant-enforced) store, else the rows' store. */
export const resolveStore = async (res, rows = []) => {
  const req = res?.req;
  const id = Number(req?.storeId ?? req?.query?.storeId) || Number(rows[0]?.storeId) || null;
  if (!id) return { storeName: "" };
  return (await prisma.store.findUnique({ where: { id }, select: storeSelect })) || { storeName: "" };
};

const metaFor = (store, filter = {}, rowCount, filters = []) => {
  const period = String(filter.period || "THIS_MONTH").toUpperCase();
  const from = filter.fromDate ? istDateKey(filter.fromDate) : null;
  const to = filter.toDate ? istDateKey(filter.toDate) : null;
  return {
    store,
    period,
    periodName: periodName(period),
    periodLabel: period === "ALL" ? "All dates" : from && to ? `${formatDate(from)} – ${formatDate(to)}` : periodName(period),
    from: period === "ALL" ? null : from,
    to: period === "ALL" ? null : to,
    generatedAt: new Date().toISOString(),
    rowCount,
    filters,
    notes: [],
  };
};

export const buildSalesReport = async (reportData = {}, res) => {
  const def = getDefinition("sales-register");
  const all = reportData.sales || [];
  const sales = all.filter((s) => s.status !== "CANCELLED");
  const cancelled = all.length - sales.length;
  const rows = sales.map((s) => {
    const items = s.items || [];
    const agg = {
      pieces: items.reduce((t, i) => t + (Number(i.pieces) || 1), 0),
      grossWeight: items.reduce((t, i) => t + n(i.grossWeight), 0),
      netWeight: items.reduce((t, i) => t + n(i.netWeight), 0),
    };
    const modes = [...new Set((s.payments || []).map((p) => MODE_LABEL[p.paymentMode] || p.paymentMode))].join(", ");
    return { ...saleRow(s, agg), modes };
  });
  const columns = resolveColumns(def, { status: "COMPLETED" });
  const store = await resolveStore(res, all);
  const summary = [
    { label: "Invoices", value: rows.length, type: "number" },
    { label: "Invoice Value", value: roundMoney(sumBy(rows, "invoiceValue")), type: "money" },
    { label: "Taxable Value", value: roundMoney(sumBy(rows, "taxable")), type: "money" },
    { label: "GST", value: roundMoney(sumBy(rows, "gst")), type: "money" },
    { label: "Collected", value: roundMoney(sumBy(rows, "paid")), type: "money" },
    { label: "Outstanding", value: roundMoney(sumBy(rows, "due")), type: "money" },
  ];
  if (cancelled) summary.push({ label: "Cancelled (excluded)", value: cancelled, type: "number" });
  return {
    key: "sales-report",
    name: "Sales Report",
    group: "Sales",
    description: def.description,
    orientation: "landscape",
    columns: columns.map((c) => ({ align: ["money", "weight", "number", "percent"].includes(c.type) ? "right" : "left", ...c })),
    rows,
    totals: computeTotals(columns, rows),
    totalsLabel: "Total",
    summary,
    meta: metaFor(store, reportData.filter, rows.length),
  };
};

const TYPE_LABEL = { ALL: "All", ORNAMENT: "Ornament", BULLION: "Bullion", OLD: "Old Gold / URD" };

export const buildPurchaseReport = async (reportData = {}, res) => {
  const def = getDefinition("purchase-register");
  const purchases = reportData.purchases || [];
  const rows = purchases.map((p) => {
    const items = p.items || [];
    const w = {
      pieces: items.reduce((t, i) => t + (i.pieces ?? 1), 0),
      grossWeight: items.reduce((t, i) => t + n(i.grossWeight), 0),
      netWeight: items.reduce((t, i) => t + n(i.netWeight), 0),
      pureWeight: items.reduce((t, i) => t + pureOf(i.pureWeight, i.netWeight, i.purity), 0),
    };
    return purchaseRow(p, w);
  });
  const columns = resolveColumns(def, {});
  const store = await resolveStore(res, purchases);
  const type = String(res?.req?.query?.purchaseType || "ALL").toUpperCase();
  return {
    key: "purchase-report",
    name: "Purchase Report",
    group: "Purchase",
    description: def.description,
    orientation: "landscape",
    columns: columns.map((c) => ({ align: ["money", "weight", "number", "percent"].includes(c.type) ? "right" : "left", ...c })),
    rows,
    totals: computeTotals(columns, rows),
    totalsLabel: "Total",
    summary: [
      { label: "Bills", value: rows.length, type: "number" },
      { label: "Net Purchase", value: roundMoney(sumBy(rows, "netAmount")), type: "money" },
      { label: "GST", value: roundMoney(sumBy(rows, "gst")), type: "money" },
      { label: "Net Weight (g)", value: roundWeight(sumBy(rows, "netWeight")), type: "weight" },
      { label: "Paid", value: roundMoney(sumBy(rows, "paid")), type: "money" },
      { label: "Amount Owed", value: roundMoney(sumBy(rows, "due")), type: "money" },
    ],
    meta: metaFor(store, reportData.filter, rows.length, type !== "ALL" ? [{ label: "Purchase Type", value: TYPE_LABEL[type] || type }] : []),
  };
};
