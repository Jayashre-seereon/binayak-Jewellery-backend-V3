import prisma from "../config/db.js";
import { nextCounter } from "./counter.js";

export const formatEmployeeCode = (n) => `EMP-${String(n).padStart(4, "0")}`;

/**
 * Next free employee code for a store (codes are unique per store: @@unique([storeId, empCode])).
 * Must be called with the transaction client that also creates the employee, so a failed
 * create rolls the counter back. Skips codes already taken (e.g. migrated/manual codes
 * that ran ahead of the counter).
 */
export const generateEmployeeCode = async (storeId, tx = prisma) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const n = await nextCounter(storeId, "lastEmpNumber", tx);
    const empCode = formatEmployeeCode(n);
    const taken = await tx.employee.findFirst({ where: { storeId: Number(storeId), empCode }, select: { id: true } });
    if (!taken) return empCode;
  }
  throw new Error("Could not allocate an employee code");
};
