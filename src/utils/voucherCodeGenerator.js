import prisma from "../config/db.js";
import { nextCounter } from "./counter.js";
import { AppError } from "./validate.js";

// Voucher numbers are per store (Voucher @@unique([storeId, voucherNo])); every reversal or
// lookup by number must therefore also filter by storeId.
const SERIES = {
  RECEIPT: { field: "lastReceiptVoucherNumber", prefix: "RV" },
  PAYMENT: { field: "lastPaymentVoucherNumber", prefix: "PV" },
  JOURNAL: { field: "lastJournalVoucherNumber", prefix: "JE" },
};

const seriesFor = (voucherType) => {
  const s = SERIES[String(voucherType || "").toUpperCase()];
  if (!s) throw new AppError(`Unknown voucher type: ${voucherType}`);
  return s;
};

const format = (prefix, n) => `${prefix}-${String(n).padStart(6, "0")}`;

/** Allocates the next number atomically; pass the voucher transaction so it rolls back with it. */
export const generateVoucherNo = async (storeId, voucherType, tx = prisma) => {
  const sid = Number(storeId);
  if (!Number.isInteger(sid) || sid <= 0) throw new AppError("Valid storeId is required for voucher numbering.");
  const { field, prefix } = seriesFor(voucherType);
  return format(prefix, await nextCounter(sid, field, tx));
};

/** Preview only (not reserved): the number the next voucher will most likely get. */
export const peekNextVoucherNo = async (storeId, voucherType, tx = prisma) => {
  const sid = Number(storeId);
  if (!Number.isInteger(sid) || sid <= 0) return "";
  const { field, prefix } = seriesFor(voucherType);
  const counter = await tx.storeCounter.findUnique({ where: { storeId: sid }, select: { [field]: true } });
  return format(prefix, Number(counter?.[field] || 0) + 1);
};
