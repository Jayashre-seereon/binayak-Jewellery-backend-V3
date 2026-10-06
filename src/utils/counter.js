import prisma from "../config/db.js";

/**
 * Atomically increments a StoreCounter column and returns the new value.
 * Runs inside the caller's transaction when `tx` is given (rolled back with it).
 */
export const nextCounter = async (storeId, field, tx = prisma) => {
  const sid = Number(storeId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const row = await tx.storeCounter.upsert({
        where: { storeId: sid },
        create: { storeId: sid, [field]: 1 },
        update: { [field]: { increment: 1 } },
        select: { [field]: true },
      });
      return Number(row[field]);
    } catch (err) {
      if (err?.code === "P2002" && attempt < 2) continue; // concurrent first-time create
      throw err;
    }
  }
  throw new Error("Could not allocate a sequence number");
};

/** Indian financial year label for a date, e.g. 2026-10-03 -> "26-27". */
export const financialYear = (date = new Date()) => {
  const d = new Date(date);
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${String(y).slice(-2)}-${String(y + 1).slice(-2)}`;
};
