// Inventory numbering (BRIEF rule 5). Sequences come only from StoreCounter.lastInventoryNumber;
// existing codes are never parsed. Barcodes embed the store id so they are unique across stores.
import { nextCounter } from "../../utils/counter.js";
import { AppError } from "../../utils/validate.js";

export const inventoryCodeFor = (seq) => `INV-${String(seq).padStart(6, "0")}`;
export const tagNoFor = (storeId, seq) => `TAG-S${Number(storeId)}-${String(seq).padStart(6, "0")}`;
export const barcodeFor = (storeId, seq) => `89${String(Number(storeId)).padStart(3, "0")}${String(seq).padStart(7, "0")}`;

const MAX_SKIPS = 50;

/**
 * Allocates the next free sequence for a store inside `tx`. A number whose code, tag or barcode
 * already exists in the store (e.g. a migrated row) is skipped, never reused.
 * `need` selects which values must be free: { code, tag, barcode }.
 */
export const allocateInventoryNumbers = async (tx, storeId, need = { code: true, tag: true, barcode: true }) => {
  const sid = Number(storeId);
  for (let i = 0; i < MAX_SKIPS; i += 1) {
    const seq = await nextCounter(sid, "lastInventoryNumber", tx);
    if (seq > 9999999) throw new AppError("Inventory numbers for this store have reached the supported limit.", 409);
    const candidate = { seq, inventoryCode: inventoryCodeFor(seq), tagNo: tagNoFor(sid, seq), barcodeNo: barcodeFor(sid, seq) };
    const or = [];
    if (need.code) or.push({ inventoryCode: candidate.inventoryCode });
    if (need.tag) or.push({ tagNo: candidate.tagNo });
    if (need.barcode) or.push({ barcodeNo: candidate.barcodeNo });
    const clash = or.length ? await tx.inventory.findFirst({ where: { storeId: sid, OR: or }, select: { id: true } }) : null;
    if (!clash) return candidate;
  }
  throw new AppError("Could not allocate a free inventory number. Please try again.", 409);
};
