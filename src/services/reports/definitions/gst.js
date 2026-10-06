import prisma from "../../../config/db.js";
import { roundMoney, roundWeight } from "../../../utils/validate.js";
import { n, sumBy } from "../engine.js";
import { dateRangeWhere } from "./common.js";

const HSN_NAMES = [
  ["711311", "Silver jewellery"],
  ["711319", "Gold / precious-metal jewellery"],
  ["711320", "Base metal clad jewellery"],
  ["7113", "Articles of jewellery"],
  ["7114", "Goldsmiths' / silversmiths' wares"],
  ["7117", "Imitation jewellery"],
  ["7108", "Gold (bullion)"],
  ["7106", "Silver (bullion)"],
  ["7110", "Platinum"],
  ["7102", "Diamonds"],
  ["7103", "Precious / semi-precious stones"],
  ["9988", "Job work / making services"],
];
const hsnName = (code) => HSN_NAMES.find(([p]) => String(code || "").startsWith(p))?.[1] || "";

const gstSummary = {
  key: "gst-summary",
  name: "GST Summary (HSN-wise)",
  group: "GST",
  description: "Outward supplies by HSN: taxable value, CGST, SGST, IGST — reconciled to invoice totals (for GSTR-1 Table 12).",
  orientation: "landscape",
  defaultPeriod: "LAST_MONTH",
  filters: [],
  columns: [
    { key: "hsn", label: "HSN", type: "text" },
    { key: "description", label: "Description", type: "text" },
    { key: "rate", label: "GST Rate", type: "percent", align: "center" },
    { key: "invoices", label: "Invoices", type: "number", total: true, align: "center" },
    { key: "pieces", label: "Pcs", type: "number", total: true, align: "center" },
    { key: "netWeight", label: "Net Wt (g)", type: "weight", total: true },
    { key: "taxable", label: "Taxable Value", type: "money", total: true },
    { key: "cgst", label: "CGST", type: "money", total: true },
    { key: "sgst", label: "SGST", type: "money", total: true },
    { key: "igst", label: "IGST", type: "money", total: true },
    { key: "tax", label: "Total Tax", type: "money", total: true },
    { key: "value", label: "Invoice Value", type: "money", total: true },
  ],
  query: async (storeId, range) => {
    const d = dateRangeWhere(range);
    const saleWhere = { storeId, status: "COMPLETED", ...(d ? { saleDate: d } : {}) };
    const [sales, items, purchases] = await Promise.all([
      prisma.sale.findMany({
        where: saleWhere,
        select: { id: true, taxableAmount: true, cgstAmount: true, sgstAmount: true, igstAmount: true, cgst: true, sgst: true, igst: true, gstType: true, placeOfSupply: true },
      }),
      prisma.saleItem.findMany({ where: { sale: { is: saleWhere } }, select: { saleId: true, hsnCode: true, pieces: true, netWeight: true, taxableAmount: true } }),
      prisma.purchase.aggregate({
        where: { storeId, isRCM: false, ...(d ? { date: d } : {}) },
        _sum: { cgst: true, sgst: true, igst: true, taxableAmount: true },
      }),
    ]);
    const itemsBySale = new Map();
    for (const it of items) {
      if (!itemsBySale.has(it.saleId)) itemsBySale.set(it.saleId, []);
      itemsBySale.get(it.saleId).push(it);
    }
    // The invoice header is authoritative for tax; it is split across its lines by line taxable value,
    // so the HSN table always adds up to the sales register.
    const hsn = new Map();
    let inter = 0;
    for (const s of sales) {
      const lines = itemsBySale.get(s.id) || [{ hsnCode: "711319", pieces: 0, netWeight: 0, taxableAmount: 0 }];
      const base = lines.reduce((t, l) => t + n(l.taxableAmount), 0);
      const tx = { taxable: n(s.taxableAmount), cgst: n(s.cgstAmount || s.cgst), sgst: n(s.sgstAmount || s.sgst), igst: n(s.igstAmount || s.igst) };
      if (tx.igst > 0) inter += 1;
      const seen = new Set();
      for (const l of lines) {
        const share = base > 0 ? n(l.taxableAmount) / base : 1 / lines.length;
        const code = String(l.hsnCode || "711319").trim() || "711319";
        const g = hsn.get(code) || { hsn: code, description: hsnName(code), invoices: 0, pieces: 0, netWeight: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
        if (!seen.has(code)) {
          g.invoices += 1;
          seen.add(code);
        }
        g.pieces += n(l.pieces);
        g.netWeight += n(l.netWeight);
        for (const k of ["taxable", "cgst", "sgst", "igst"]) g[k] += tx[k] * share;
        hsn.set(code, g);
      }
    }
    const rows = [...hsn.values()]
      .sort((a, b) => b.taxable - a.taxable)
      .map((g) => {
        const tax = roundMoney(g.cgst + g.sgst + g.igst);
        const taxable = roundMoney(g.taxable);
        return {
          ...g,
          netWeight: roundWeight(g.netWeight),
          taxable,
          cgst: roundMoney(g.cgst),
          sgst: roundMoney(g.sgst),
          igst: roundMoney(g.igst),
          tax,
          rate: taxable > 0 ? Math.round((tax / taxable) * 10000) / 100 : 0,
          value: roundMoney(taxable + tax),
        };
      });
    const outTax = roundMoney(sumBy(rows, "tax"));
    const inTax = roundMoney(n(purchases._sum.cgst) + n(purchases._sum.sgst) + n(purchases._sum.igst));
    return {
      rows,
      summary: [
        { label: "Taxable Value", value: roundMoney(sumBy(rows, "taxable")), type: "money" },
        { label: "CGST", value: roundMoney(sumBy(rows, "cgst")), type: "money" },
        { label: "SGST", value: roundMoney(sumBy(rows, "sgst")), type: "money" },
        { label: "IGST", value: roundMoney(sumBy(rows, "igst")), type: "money" },
        { label: "Output GST", value: outTax, type: "money" },
        { label: "Input GST (purchases)", value: inTax, type: "money" },
        { label: "Net GST Payable", value: roundMoney(outTax - inTax), type: "money" },
        { label: "Invoices (inter-state)", value: `${sales.length} (${inter})`, type: "text" },
      ],
      notes: ["Tax per HSN is the invoice-level GST split across its lines in proportion to line taxable value. Input GST excludes reverse-charge (RCM) purchases."],
    };
  },
};

export default [gstSummary];
