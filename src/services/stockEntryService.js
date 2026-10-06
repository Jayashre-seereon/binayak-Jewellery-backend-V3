/**
 * Stock Entry — the one-screen way to put pieces on the counter.
 *
 * One request = one purchase document (supplier purchase or opening/own stock) whose every line
 * is tagged as a stock piece in the same transaction. Each piece gets its own unique barcode:
 * the tag it already carries (scanned/typed) or a generated one.
 */
import prisma from "../config/db.js";
import { createPurchase } from "./purchaseService.js";
import { createInventoryInTx } from "./inventoryService.js";
import { findBarcodeOwner } from "./barcodeService.js";
import { validateBarcodeValue } from "./barcode/symbology.js";
import { cancelPurchaseJournal } from "./purchase/purchaseLedger.js";
import { AppError, toNumber, cleanString, parseId, optionalId } from "../utils/validate.js";

export const MAX_STOCK_LINES = 200;
const MODES = ["OPENING", "PURCHASE"];
const SALE_MAKING_TYPES = ["PERCENT", "PER_GRAM", "FLAT"];

const rowError = (i, msg, status = 400) => new AppError(`Row ${i + 1}: ${msg}`, status);

const normaliseLine = (raw, i, mode) => {
  if (!raw || typeof raw !== "object") throw rowError(i, "invalid line.");
  const itemId = optionalId(raw.itemId, "item");
  if (!itemId) throw rowError(i, "please choose an item.");
  const barcode = raw.barcode === undefined || raw.barcode === null || String(raw.barcode).trim() === ""
    ? null
    : (() => {
        try { return validateBarcodeValue(raw.barcode); } catch (e) { throw rowError(i, e.message); }
      })();
  let saleMakingType = raw.saleMakingType ? String(raw.saleMakingType).toUpperCase() : null;
  if (saleMakingType && !SALE_MAKING_TYPES.includes(saleMakingType)) throw rowError(i, "sale making type must be PERCENT, PER_GRAM or FLAT.");
  const saleMakingRate = raw.saleMakingRate === undefined || raw.saleMakingRate === null || raw.saleMakingRate === ""
    ? null
    : toNumber(raw.saleMakingRate, { field: `Row ${i + 1}: sale making rate`, max: saleMakingType === "PERCENT" ? 100 : 1e7 });
  if (saleMakingRate !== null && !saleMakingType) saleMakingType = "PER_GRAM";
  const huid = cleanString(raw.huidNo, 20);
  if (huid && !/^[A-Za-z0-9]{1,20}$/.test(huid)) throw rowError(i, "HUID must be letters and digits only.");

  const money = mode === "PURCHASE";
  return {
    purchaseLine: {
      itemId,
      purityId: raw.purityId,
      gradeId: raw.gradeId,
      pieces: raw.pieces,
      grossWeight: raw.grossWeight,
      stoneWeight: raw.stoneWeight,
      huidNo: huid,
      rate: money ? raw.rate : 0,
      makingCharges: money ? raw.makingCharges : 0,
      stoneAmount: money ? raw.stoneAmount : 0,
      hallmarkCharges: money ? raw.hallmarkCharges : 0,
      narration: raw.narration,
    },
    barcode,
    saleMakingType,
    saleMakingRate,
  };
};

/** Every piece needs a purity (it drives the sale rate); default from the item, then its product. */
const assertPurities = async (storeId, lines) => {
  const ids = [...new Set(lines.map((l) => l.purchaseLine.itemId))];
  const items = await prisma.item.findMany({
    where: { id: { in: ids }, storeId },
    select: { id: true, purityId: true, product: { select: { purityId: true } } },
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  lines.forEach((l, i) => {
    const it = byId.get(l.purchaseLine.itemId);
    if (!it) throw rowError(i, "the selected item is not in this store.");
    const given = optionalId(l.purchaseLine.purityId, "purity");
    const purityId = given || it.purityId || it.product?.purityId || null;
    if (!purityId) throw rowError(i, "please choose the purity (the item has no default purity).");
    l.purchaseLine.purityId = purityId;
  });
};

/** Pre-flight: a barcode may appear once in the entry and must be free in the store. */
const assertBarcodesFree = async (storeId, lines) => {
  const seen = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const code = lines[i].barcode;
    if (!code) continue;
    const key = code.toLowerCase();
    if (seen.has(key)) throw rowError(i, `barcode ${code} is repeated (also on row ${seen.get(key) + 1}).`, 409);
    seen.set(key, i);
    const owner = await findBarcodeOwner(storeId, code);
    if (owner) throw rowError(i, `barcode ${code} is already used by ${owner}.`, 409);
  }
};

export const createStockEntry = async (storeId, body = {}) => {
  const sid = Number(storeId);
  const mode = String(body.mode || "").toUpperCase();
  if (!MODES.includes(mode)) throw new AppError("Please choose Opening / own stock or Supplier purchase.");
  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  if (!rawLines.length) throw new AppError("Please add at least one piece.");
  if (rawLines.length > MAX_STOCK_LINES) throw new AppError(`At most ${MAX_STOCK_LINES} pieces can be entered at once.`);
  const lines = rawLines.map((l, i) => normaliseLine(l, i, mode));
  if (mode === "PURCHASE" && !optionalId(body.partyId, "party")) throw new AppError("Please choose the supplier.");
  await assertPurities(sid, lines);
  await assertBarcodesFree(sid, lines);

  const purchaseData = {
    purchaseType: "ORNAMENT",
    date: body.date,
    narration: cleanString(body.narration, 1000) || (mode === "OPENING" ? "Stock entry (opening / own stock)" : null),
    items: lines.map((l) => l.purchaseLine),
    ...(mode === "PURCHASE"
      ? {
          partyId: body.partyId,
          referenceNo: body.referenceNo,
          applyGst: body.applyGst,
          placeOfSupply: body.placeOfSupply,
          isRCM: body.isRCM,
          payments: body.payments,
          discount: body.discount,
        }
      : { applyGst: false }),
  };

  const onCreated = async (tx, purchase) => {
    const pieces = [];
    const items = [...purchase.items].sort((a, b) => a.id - b.id);
    for (let i = 0; i < items.length; i += 1) {
      const line = lines[i];
      const extraDetails = {
        source: "STOCK_ENTRY",
        ...(line.saleMakingType ? { makingChargeType: line.saleMakingType, makingChargeRate: line.saleMakingRate ?? 0 } : {}),
        ...(line.barcode ? { adoptedBarcode: true } : {}),
      };
      try {
        const piece = await createInventoryInTx(tx, { ...items[i], purchase }, sid, { barcode: line.barcode, extraDetails });
        pieces.push(piece);
      } catch (e) {
        if (e?.status) throw rowError(i, e.message.replace(/^Barcode/, "barcode"), e.status);
        if (e?.code === "P2002") throw rowError(i, "barcode is already used by another piece.", 409);
        throw e;
      }
    }
    return pieces;
  };

  // purchaseCalc already reports line problems as "Row N: ...".
  const created = await createPurchase(purchaseData, sid, { isOpeningStock: mode === "OPENING", onCreated });
  const pieces = (created.stockEntry || []).map((p) => ({
    id: p.id,
    inventoryCode: p.inventoryCode,
    barcodeNo: p.barcodeNo,
    tagNo: p.tagNo,
    itemName: p.item?.name || null,
    productName: p.product?.name || null,
    purityName: p.purityMaster?.name || null,
    pieces: p.pieces,
    grossWeight: p.grossWeight,
    stoneWeight: p.stoneWeight,
    netWeight: p.netWeight,
    huidNo: p.huidNo,
    status: p.status,
  }));
  return {
    purchase: {
      id: created.id,
      invoiceNo: created.invoiceNo,
      date: created.date,
      netPayable: created.netPayable,
      isOpeningStock: created.isOpeningStock,
      gstType: created.gstType,
    },
    pieces,
  };
};

/** Stock entries = purchases created by Stock Entry (every line tagged at once). */
const entryWhere = (sid, search) => {
  const where = {
    storeId: sid,
    purchaseType: "ORNAMENT",
    invoiceNo: { startsWith: "PUR/" },
    inventory: { some: { extraDetails: { path: ["source"], equals: "STOCK_ENTRY" } } },
  };
  const term = String(search || "").trim().slice(0, 100);
  if (term) {
    where.OR = [
      { invoiceNo: { contains: term, mode: "insensitive" } },
      { referenceNo: { contains: term, mode: "insensitive" } },
      { party: { name: { contains: term, mode: "insensitive" } } },
      { inventory: { some: { barcodeNo: { contains: term, mode: "insensitive" } } } },
    ];
  }
  return where;
};

export const listStockEntries = async (storeId, { page = 1, limit = 20, search = "" } = {}) => {
  const sid = Number(storeId);
  const p = Math.max(1, Math.floor(Number(page)) || 1);
  const l = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 20));
  const where = entryWhere(sid, search);
  const [rows, total] = await prisma.$transaction([
    prisma.purchase.findMany({
      where,
      select: {
        id: true, invoiceNo: true, date: true, isOpeningStock: true, netPayable: true, referenceNo: true,
        party: { select: { name: true } },
        inventory: { select: { id: true, status: true, pieces: true, grossWeight: true, netWeight: true, _count: { select: { saleItems: true, transferItems: true } } } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (p - 1) * l,
      take: l,
    }),
    prisma.purchase.count({ where }),
  ]);
  const data = rows.map((r) => ({
    id: r.id,
    invoiceNo: r.invoiceNo,
    date: r.date,
    mode: r.isOpeningStock ? "OPENING" : "PURCHASE",
    partyName: r.party?.name || null,
    referenceNo: r.referenceNo,
    tags: r.inventory.length,
    pieces: r.inventory.reduce((t, i) => t + (Number(i.pieces) || 1), 0),
    grossWeight: Number(r.inventory.reduce((t, i) => t + Number(i.grossWeight || 0), 0).toFixed(3)),
    netWeight: Number(r.inventory.reduce((t, i) => t + Number(i.netWeight || 0), 0).toFixed(3)),
    netPayable: r.isOpeningStock ? null : r.netPayable,
    deletable: r.inventory.every((i) => i.status === "AVAILABLE" && i._count.saleItems === 0 && i._count.transferItems === 0),
  }));
  return { data, pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l) } };
};

/** Undo a stock entry: only while every piece is still AVAILABLE and has never moved. */
export const deleteStockEntry = async (storeId, id, actor = null) => {
  const sid = Number(storeId);
  const purchaseId = parseId(id, "stock entry");
  return prisma.$transaction(async (tx) => {
    const purchase = await tx.purchase.findFirst({
      where: { id: purchaseId, ...entryWhere(sid, "") },
      include: {
        inventory: { select: { id: true, status: true, barcodeNo: true, _count: { select: { saleItems: true, transferItems: true } } } },
        payments: { select: { id: true, voucherId: true } },
      },
    });
    if (!purchase) throw new AppError("Stock entry not found.", 404);
    const blocker = purchase.inventory.find((i) => i.status !== "AVAILABLE" || i._count.saleItems > 0 || i._count.transferItems > 0);
    if (blocker) {
      throw new AppError(`Piece ${blocker.barcodeNo} is ${blocker.status}${blocker._count.saleItems || blocker._count.transferItems ? " or has history" : ""}; this entry can no longer be deleted.`, 409);
    }
    if (purchase.payments.some((p) => p.voucherId)) {
      throw new AppError("A payment voucher is recorded against this purchase. Cancel the voucher first.", 409);
    }
    const ids = purchase.inventory.map((i) => i.id);
    const removed = await tx.inventory.deleteMany({ where: { id: { in: ids }, storeId: sid, status: "AVAILABLE" } });
    if (removed.count !== ids.length) throw new AppError("A piece changed while deleting. Please reload and try again.", 409);
    if (!purchase.isOpeningStock) {
      const who = actor?.email ? ` by ${actor.email}` : "";
      await cancelPurchaseJournal(tx, purchase, `Stock entry ${purchase.invoiceNo} deleted${who}`);
    }
    // Cancelled journals stay in the books (with the bill number) but no longer point at the row.
    await tx.voucher.updateMany({ where: { purchaseId: purchase.id, storeId: sid }, data: { purchaseId: null } });
    await tx.purchasePayment.deleteMany({ where: { purchaseId: purchase.id } });
    await tx.purchaseItem.deleteMany({ where: { purchaseId: purchase.id } });
    await tx.purchase.delete({ where: { id: purchase.id } });
    return { id: purchase.id, invoiceNo: purchase.invoiceNo, pieces: ids.length };
  }, { maxWait: 20000, timeout: 60000 });
};

export const checkBarcode = async (storeId, rawCode) => {
  let code;
  try {
    code = validateBarcodeValue(rawCode);
  } catch (e) {
    return { available: false, usedBy: null, invalid: e.message };
  }
  const owner = await findBarcodeOwner(storeId, code);
  return { available: !owner, usedBy: owner, code };
};
