// Filters, labels and small helpers shared by the report definitions.
export const LEGACY_REF_TYPES = ["RetailInvoice", "OldMetalPurchase", "AdvanceReceive"];
export const isLegacyRef = (t) => LEGACY_REF_TYPES.includes(t);

/** Prisma where-fragment for a voucher that is NOT a migrated legacy voucher. */
export const nonLegacyVoucher = { OR: [{ referenceType: null }, { referenceType: { notIn: LEGACY_REF_TYPES } }] };

export const SALE_STATUS_FILTER = {
  name: "status",
  label: "Status",
  type: "select",
  default: "COMPLETED",
  options: [
    { value: "COMPLETED", label: "Completed" },
    { value: "CANCELLED", label: "Cancelled" },
    { value: "ALL", label: "All" },
  ],
};

export const VOUCHER_STATUS_FILTER = {
  name: "status",
  label: "Status",
  type: "select",
  default: "COMPLETED",
  options: [
    { value: "COMPLETED", label: "Active" },
    { value: "CANCELLED", label: "Cancelled" },
    { value: "ALL", label: "All" },
  ],
};

export const PURCHASE_TYPE_FILTER = {
  name: "purchaseType",
  label: "Purchase Type",
  type: "select",
  default: "ALL",
  options: [
    { value: "ALL", label: "All" },
    { value: "ORNAMENT", label: "Ornament" },
    { value: "BULLION", label: "Bullion" },
    { value: "OLD", label: "Old Gold / URD" },
  ],
};

export const INVENTORY_STATUS_FILTER = {
  name: "status",
  label: "Stock Status",
  type: "select",
  default: "AVAILABLE",
  options: [
    { value: "AVAILABLE", label: "Available" },
    { value: "RESERVED", label: "Reserved" },
    { value: "PENDING", label: "In Transit" },
    { value: "SOLD", label: "Sold" },
    { value: "DAMAGED", label: "Damaged" },
    { value: "MELTED", label: "Melted" },
    { value: "REFINED", label: "Refined" },
    { value: "ALL", label: "All" },
  ],
};

export const PAYMENT_MODE_FILTER = {
  name: "paymentMode",
  label: "Payment Mode",
  type: "select",
  default: "ALL",
  options: [
    { value: "ALL", label: "All" },
    { value: "CASH", label: "Cash" },
    { value: "UPI", label: "UPI" },
    { value: "CARD", label: "Card" },
    { value: "ONLINE", label: "Online / Bank" },
    { value: "CHEQUE", label: "Cheque" },
    { value: "OTHER", label: "Other" },
  ],
};

export const GROUP_BY_PERIOD_FILTER = {
  name: "groupBy",
  label: "Group By",
  type: "select",
  default: "DAY",
  options: [
    { value: "DAY", label: "Day" },
    { value: "MONTH", label: "Month" },
  ],
};

export const SEARCH_FILTER = (label = "Search") => ({ name: "search", label, type: "text" });

export const INCLUDE_LEGACY_FILTER = (def = true) => ({ name: "includeLegacy", label: "Include migrated (legacy) vouchers", type: "boolean", default: def });

export const contains = (s) => ({ contains: s, mode: "insensitive" });

export const dateRangeWhere = (range) => (range ? { gte: range.from, lte: range.to } : undefined);

export const PURCHASE_TYPE_LABEL = { ORNAMENT: "Ornament", BULLION: "Bullion", OLD: "Old Gold / URD" };

const REF_LABEL = {
  RetailInvoice: "Retail invoice (legacy)",
  OldMetalPurchase: "Old metal purchase (legacy)",
  AdvanceReceive: "Advance (legacy)",
  SALE: "Sale",
  PURCHASE: "Purchase",
  SALE_INVOICE: "Sale invoice",
  ADVANCE: "Advance",
  OTHER: "Other",
};
export const referenceLabel = (type, docNo) => {
  const base = type ? REF_LABEL[type] || String(type).replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : "";
  return [base, docNo].filter(Boolean).join(" · ");
};

/** Best-effort payment mode from a voucher mode or (legacy) the cash/bank account it hit. */
export const normaliseMode = (mode, accountName = "") => {
  const m = String(mode || "").toUpperCase();
  if (["CASH", "UPI", "CARD", "CHEQUE", "OTHER"].includes(m)) return m;
  if (["ONLINE", "BANK", "NEFT", "RTGS", "IMPS", "TRANSFER"].includes(m)) return "ONLINE";
  const a = String(accountName || "");
  if (!m && a) {
    if (/cash/i.test(a)) return "CASH";
    if (/upi|g ?pay|google ?pay|phone ?pe|phone ?pay|paytm|bhim/i.test(a)) return "UPI";
    if (/card|terminal|pos|swipe/i.test(a)) return "CARD";
    if (/cheque|chq/i.test(a)) return "CHEQUE";
    if (/bank|sbi|hdfc|icici|axis/i.test(a)) return "ONLINE";
  }
  return "OTHER";
};
export const MODE_LABEL = { CASH: "Cash", UPI: "UPI", CARD: "Card", ONLINE: "Online / Bank", CHEQUE: "Cheque", OTHER: "Other" };

export const titleCase = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

/** Net debit/credit of a ledger line (legacy rows sometimes carry negative credits on a debit line). */
export const drCr = (e) => {
  const net = Number(e.debit || 0) - Number(e.credit || 0);
  return { dr: net > 0 ? net : 0, cr: net < 0 ? -net : 0 };
};

export const purityPct = (purity) => {
  const p = Number(purity);
  if (!Number.isFinite(p) || p <= 0) return 0;
  return p > 100 ? p / 10 : p; // fineness (916) → percent (91.6)
};
/** Pure metal content of a piece: stored pure weight, else net × purity%. */
export const pureOf = (pureWeight, netWeight, purity) => {
  const pw = Number(pureWeight || 0);
  if (pw > 0) return pw;
  return (Number(netWeight || 0) * purityPct(purity)) / 100;
};

export const ageBucket = (days) => (days <= 30 ? "b0" : days <= 60 ? "b31" : days <= 90 ? "b61" : "b90");
