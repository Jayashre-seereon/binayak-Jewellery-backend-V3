import prisma from "../config/db.js";
import { nextCounter, financialYear } from "./counter.js";

/**
 * Purchase invoice number, unique across all stores: PUR/S{storeId}/{FY}/{seq6}.
 * Pass the transaction that creates the purchase so the number is rolled back with it.
 */
export const generateInvoiceNo = async (storeId, tx = prisma, date = new Date()) => {
  const seq = await nextCounter(storeId, "lastInvoiceNumber", tx);
  return `PUR/S${Number(storeId)}/${financialYear(date)}/${String(seq).padStart(6, "0")}`;
};
