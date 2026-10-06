import prisma from "../config/db.js";
import { nextCounter, financialYear } from "./counter.js";

/**
 * Allocates the next tax-invoice number for a store.
 * Must be called inside the sale transaction (`tx`) so a failed sale never burns a number.
 * Format: S{storeId}/{FY}/{seq6}, e.g. S2/26-27/000001 — the store id keeps numbers unique
 * across stores (Sale.invoiceNo is globally unique) and the FY comes from the sale date.
 */
export const generateSaleInvoiceNo = async (storeId, saleDate = new Date(), tx = prisma) => {
  const sid = Number(storeId);
  const seq = await nextCounter(sid, "lastSaleNumber", tx);
  return `S${sid}/${financialYear(saleDate)}/${String(seq).padStart(6, "0")}`;
};
