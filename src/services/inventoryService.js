import prisma from "../config/db.js";
import * as inventoryRepo from "../repositories/inventoryRepository.js";
import { AppError, parseId, cleanString, cleanUrl } from "../utils/validate.js";
import { allocateInventoryNumbers } from "./inventory/inventoryCodes.js";
import { pieceInclude } from "../repositories/inventoryRepository.js";
import { validateBarcodeValue } from "./barcode/symbology.js";
import { findBarcodeOwner } from "./barcodeService.js";

const inventoryError = (message, status = 400) => new AppError(message, status);

export const INVENTORY_STATUSES = ["AVAILABLE", "RESERVED", "SOLD", "PENDING", "MELTED", "REFINED", "DAMAGED"];
const PURCHASE_TYPES = ["ORNAMENT", "OLD", "BULLION"];

/** Manual status changes allowed through PUT /status/:id (CONTRACT §4, INV-03). */
export const STATUS_TRANSITIONS = {
  AVAILABLE: ["RESERVED", "DAMAGED", "MELTED"],
  RESERVED: ["AVAILABLE"],
  DAMAGED: ["AVAILABLE", "MELTED"],
  MELTED: ["REFINED"],
};

export const MAX_BULK_INVENTORY = 500;

const inventoryInclude = pieceInclude;

const asString = (value) => (value === null || value === undefined ? null : String(value));

/**
 * Old gold bought from customers is scrap/exchange metal, not counter stock, so it starts in a
 * non-saleable state (DAMAGED -> MELTED, or -> AVAILABLE if it is to be resold as is) (INV-09).
 */
const initialStatusFor = (purchaseType) => (purchaseType === "OLD" ? "DAMAGED" : "AVAILABLE");

const isPurchaseItemUniqueError = (error) => {
  const target = error?.meta?.target;
  const key = Array.isArray(target) ? target.join(",") : String(target || "");
  return error?.code === "P2002" && key.includes("purchaseItemId");
};

/**
 * Validates a barcode the user wants a piece to carry (its existing tag, a manufacturer code)
 * and checks nothing else in the store uses it.
 */
export const assertPieceBarcodeFree = async (storeId, rawBarcode, { excludeInventoryId = null, tx = prisma } = {}) => {
  const barcode = validateBarcodeValue(rawBarcode);
  const owner = await findBarcodeOwner(storeId, barcode, { excludeInventoryId });
  if (owner) throw inventoryError(`Barcode ${barcode} is already used by ${owner}.`, 409);
  // Inside a transaction, also see pieces created earlier in the same transaction.
  if (tx !== prisma) {
    const dup = await tx.inventory.findFirst({ where: { storeId: Number(storeId), barcodeNo: { equals: barcode, mode: "insensitive" } }, select: { id: true } });
    if (dup && dup.id !== excludeInventoryId) throw inventoryError(`Barcode ${barcode} is already used by another piece.`, 409);
  }
  return barcode;
};

/**
 * Tags one purchase line as a stock piece inside `tx`. `barcode` (optional) keeps the tag the
 * piece already carries; otherwise a store-unique barcode is generated.
 */
export const createInventoryInTx = async (tx, purchaseItem, storeIdNumber, { barcode = null, purchaseType = null, extraDetails = undefined } = {}) => {
  const type = purchaseType || purchaseItem.purchase.purchaseType;
  const own = barcode ? await assertPieceBarcodeFree(storeIdNumber, barcode, { tx }) : null;
  const codes = await allocateInventoryNumbers(tx, storeIdNumber, { code: true, tag: true, barcode: !own });
  const data = {
    inventoryCode: codes.inventoryCode,

    purchaseItemId: purchaseItem.id,
    purchaseId: purchaseItem.purchaseId,
    storeId: storeIdNumber,

    purchaseType: type,

    itemId: purchaseItem.itemId,
    productId: purchaseItem.productId,
    metalId: purchaseItem.metalId,
    purityId: purchaseItem.purityId,
    gradeId: purchaseItem.gradeId,
    stoneId: purchaseItem.stoneId,

    grossWeight: purchaseItem.grossWeight,
    stoneWeight: purchaseItem.stoneWeight,
    netWeight: purchaseItem.netWeight,
    pieces: Math.max(1, Number(purchaseItem.pieces || 1)),

    dustWeight: purchaseItem.dustWeight,
    deductionWeight: purchaseItem.deductionWeight,

    pureWeight: purchaseItem.pureWeight,
    actualWeight: purchaseItem.actualWeight,
    balanceWeight: purchaseItem.balanceWeight,

    purity: purchaseItem.purity,
    touchPercentage: purchaseItem.touchPercentage,
    fineness: purchaseItem.fineness,

    huidNo: asString(purchaseItem.huidNo),
    hsnCode: asString(purchaseItem.hsnCode) || "711319",
    tagNo: codes.tagNo,
    barcodeNo: own || codes.barcodeNo,
    barSerialNo: asString(purchaseItem.barSerialNo),
    assayCertNo: asString(purchaseItem.assayCertNo),

    status: initialStatusFor(type),

    itemPhoto: purchaseItem.itemPhoto,
    narration: purchaseItem.narration,
    extraDetails: extraDetails ?? purchaseItem.extraDetails ?? undefined,
  };
  return tx.inventory.create({ data, include: inventoryInclude });
};

const createOne = async (purchaseItem, storeIdNumber) => {
  try {
    return await prisma.$transaction((tx) => createInventoryInTx(tx, purchaseItem, storeIdNumber), { maxWait: 20000, timeout: 60000 });
  } catch (error) {
    if (isPurchaseItemUniqueError(error)) {
      throw inventoryError("Inventory has already been created for this purchase item.", 409);
    }
    if (error?.code === "P2002") {
      throw inventoryError("Could not allocate a unique inventory number. Please try again.", 409);
    }
    throw error;
  }
};

const findPurchaseItem = (purchaseItemId, storeId) =>
  prisma.purchaseItem.findFirst({
    where: { id: purchaseItemId, purchase: { storeId } },
    include: { purchase: true, inventory: { select: { id: true } } },
  });

export const createInventoryService = async (
  purchaseItemId,
  storeId
) => {
  const storeIdNumber = Number(storeId);
  const purchaseItem = await findPurchaseItem(parseId(purchaseItemId, "purchase item"), storeIdNumber);

  if (!purchaseItem) {
    throw inventoryError("The selected purchase item was not found. Please refresh and try again.", 404);
  }

  if (purchaseItem.inventory.length > 0) {
    throw inventoryError("Inventory has already been created for this purchase item.", 409);
  }

  if (!(Number(purchaseItem.grossWeight) > 0)) {
    throw inventoryError("This purchase line has no weight and cannot be added to inventory.");
  }

  return createOne(purchaseItem, storeIdNumber);
};

/**
 * Tags every un-tagged line of a purchase (or an explicit list of lines) in one call (INV-16).
 * Lines that already have inventory are skipped and reported.
 */
export const createInventoryBulkService = async (storeId, { purchaseId, purchaseItemIds } = {}) => {
  const storeIdNumber = Number(storeId);
  let ids;
  if (Array.isArray(purchaseItemIds) && purchaseItemIds.length) {
    ids = [...new Set(purchaseItemIds.map((v) => parseId(v, "purchase item")))];
  } else if (purchaseId) {
    const rows = await prisma.purchaseItem.findMany({
      where: { purchaseId: parseId(purchaseId, "purchase"), purchase: { storeId: storeIdNumber } },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    if (!rows.length) throw inventoryError("Purchase not found or it has no items.", 404);
    ids = rows.map((r) => r.id);
  } else {
    throw inventoryError("Please select a purchase or purchase items.");
  }
  if (ids.length > MAX_BULK_INVENTORY) throw inventoryError(`At most ${MAX_BULK_INVENTORY} items can be added at once.`);

  const created = [];
  const skipped = [];
  for (const id of ids) {
    const purchaseItem = await findPurchaseItem(id, storeIdNumber);
    if (!purchaseItem) { skipped.push({ purchaseItemId: id, reason: "Not found in this store" }); continue; }
    if (purchaseItem.inventory.length > 0) { skipped.push({ purchaseItemId: id, reason: "Inventory already created" }); continue; }
    if (!(Number(purchaseItem.grossWeight) > 0)) { skipped.push({ purchaseItemId: id, reason: "No weight" }); continue; }
    try {
      created.push(await createOne(purchaseItem, storeIdNumber));
    } catch (error) {
      if (error?.status) skipped.push({ purchaseItemId: id, reason: error.message });
      else throw error;
    }
  }
  return { created, skipped };
};

const parseStatusFilter = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const list = String(value).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const bad = list.find((s) => !INVENTORY_STATUSES.includes(s));
  if (bad) throw inventoryError(`Invalid inventory status "${bad}".`);
  return list.length === 1 ? list[0] : { in: list };
};

export const getInventoriesService = async (
  storeId,
  filters = {},
  options = {}
) => {
  const clean = { ...filters };
  clean.status = parseStatusFilter(filters.status);
  if (filters.purchaseType) {
    const t = String(filters.purchaseType).toUpperCase();
    if (t === "ALL") clean.purchaseType = undefined;
    else if (!PURCHASE_TYPES.includes(t)) throw inventoryError("Invalid purchase type.");
    else clean.purchaseType = t;
  }
  for (const k of ["itemId", "productId", "metalId", "purityId"]) {
    if (filters[k] !== undefined && filters[k] !== "") clean[k] = parseId(filters[k], k);
  }
  return await inventoryRepo.getInventoriesRepo(
    Number(storeId),
    clean,
    options
  );
};

const loadOwnInventory = async (id, storeId) => {
  const inventory = await inventoryRepo.getInventoryByIdRepo(parseId(id, "inventory id"), Number(storeId));
  if (!inventory) throw inventoryError("Inventory record not found.", 404);
  return inventory;
};

export const getInventoryByIdService = async (
  id,
  storeId
) => loadOwnInventory(id, storeId);

export const getInventoryByBarcodeService = async (
  barcodeNo,
  storeId
) => {
  const code = String(barcodeNo || "").trim();
  if (!code || code.length > 64) throw inventoryError("Please enter a valid barcode number.");
  const inventory = await inventoryRepo.getInventoryByBarcodeRepo(code, Number(storeId));

  if (!inventory) {
    throw inventoryError("Inventory record not found.", 404);
  }

  return inventory;
};

// Keys of extraDetails a user may set; everything else (statusLog, previousBarcodes, relabel
// flags, legacy migration data) is maintained by the server only (SEC31-12).
const USER_EXTRA_KEYS = ["size", "gender", "color", "clarity", "certificationNo", "styleNo", "remarks", "counter", "saleMakingType", "saleMakingRate", "makingChargeType", "makingChargeRate", "mrp"];


// Only these fields may change after tagging (CONTRACT §4, INV-07); codes and weights are locked.
const EDITABLE = {
  huidNo: 50,
  hsnCode: 20,
  narration: 1000,
  itemPhoto: 1000,
  assayCertNo: 100,
  barSerialNo: 100,
};

export const updateInventoryService = async (
  id,
  storeId,
  data
) => {
  const inventory = await loadOwnInventory(id, storeId);
  if (["SOLD", "PENDING"].includes(inventory.status)) {
    throw inventoryError(`A ${inventory.status === "SOLD" ? "sold" : "in-transit"} piece cannot be edited.`);
  }

  const body = data && typeof data === "object" ? data : {};
  const update = {};
  for (const [key, max] of Object.entries(EDITABLE)) {
    if (Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined) update[key] = cleanString(body[key], max);
  }
  if (update.itemPhoto !== undefined) update.itemPhoto = cleanUrl(update.itemPhoto, "Photo");
  if (update.huidNo && !/^[A-Za-z0-9]{1,20}$/.test(update.huidNo)) {
    throw inventoryError("HUID must be alphanumeric (normally 6 characters).");
  }
  if (Object.prototype.hasOwnProperty.call(body, "extraDetails")) {
    if (body.extraDetails !== null && (typeof body.extraDetails !== "object" || Array.isArray(body.extraDetails))) {
      throw inventoryError("extraDetails must be an object.");
    }
    const current = inventory.extraDetails && typeof inventory.extraDetails === "object" ? inventory.extraDetails : {};
    const patch = {};
    for (const [k, v] of Object.entries(body.extraDetails || {})) {
      if (!USER_EXTRA_KEYS.includes(k)) continue;
      if (v !== null && typeof v === "object") throw inventoryError(`extraDetails.${k} must be a plain value.`);
      patch[k] = typeof v === "string" ? v.slice(0, 200) : v;
    }
    update.extraDetails = { ...current, ...patch };
  }
  if (Object.keys(update).length === 0) {
    throw inventoryError("Nothing to update. Only HUID, HSN, narration, photo, assay certificate, bar serial number and extra details can be changed.");
  }

  const result =
    await inventoryRepo.updateInventoryRepo(
      inventory.id,
      Number(storeId),
      update,
      { notStatus: ["SOLD", "PENDING"] }
    );

  if (result.count === 0) {
    throw inventoryError("The piece changed while you were editing it. Please reload and try again.", 409);
  }

  return loadOwnInventory(inventory.id, storeId);
};

export const updateInventoryStatusService = async (
  id,
  storeId,
  status,
  actor = null
) => {
  const target = String(status || "").trim().toUpperCase();
  if (!INVENTORY_STATUSES.includes(target)) {
    throw inventoryError("Please choose a valid inventory status.");
  }

  if (target === "SOLD") {
    throw inventoryError(
      "Inventory status cannot be manually changed to SOLD. It is automatically updated when a sales invoice is created."
    );
  }
  if (target === "PENDING") {
    throw inventoryError("PENDING is set only by stock transfers.");
  }

  const inventory = await loadOwnInventory(id, storeId);
  if (inventory.status === target) return inventory;

  if (inventory.status === "SOLD") throw inventoryError("A sold piece cannot be changed manually. Cancel the sale instead.");
  if (inventory.status === "PENDING") throw inventoryError("This piece is in an open transfer. Receive or cancel the transfer first.");

  const allowed = STATUS_TRANSITIONS[inventory.status] || [];
  if (!allowed.includes(target)) {
    throw inventoryError(`Status cannot change from ${inventory.status} to ${target}.`);
  }

  // Conditional on the status we validated against, so a concurrent sale/transfer wins.
  // Lightweight audit trail of manual status changes, kept on the piece (last 20).
  const extra = inventory.extraDetails && typeof inventory.extraDetails === "object" && !Array.isArray(inventory.extraDetails) ? inventory.extraDetails : {};
  const statusLog = [...(Array.isArray(extra.statusLog) ? extra.statusLog : []), {
    from: inventory.status,
    to: target,
    at: new Date().toISOString(),
    by: actor ? `${actor.role || ""}:${actor.email || actor.id || ""}` : null,
  }].slice(-20);

  const result =
    await inventoryRepo.updateInventoryStatusRepo(
      inventory.id,
      Number(storeId),
      target,
      inventory.status,
      { ...extra, statusLog }
    );

  if (result.count === 0) {
    throw inventoryError("The piece changed while you were updating it. Please reload and try again.", 409);
  }

  return loadOwnInventory(inventory.id, storeId);
};

export const deleteInventoryService = async (
  id,
  storeId
) => {
  const inventory = await loadOwnInventory(id, storeId);

  if (inventory.status === "SOLD") {
    throw inventoryError(
      "Sold inventory cannot be deleted."
    );
  }
  if (!["AVAILABLE", "DAMAGED"].includes(inventory.status)) {
    throw inventoryError(`A ${inventory.status} piece cannot be deleted. Only AVAILABLE or DAMAGED pieces can be deleted.`);
  }

  const [transferRef, saleRef] = await Promise.all([
    prisma.inventoryTransferItem.findFirst({ where: { inventoryId: inventory.id }, select: { id: true } }),
    prisma.saleItem.findFirst({ where: { inventoryId: inventory.id }, select: { id: true } }),
  ]);
  if (transferRef) throw inventoryError("This piece has transfer history and cannot be deleted. Mark it DAMAGED instead.");
  if (saleRef) throw inventoryError("This piece appears on a sale and cannot be deleted.");

  // The inventory number is never given back: the store counter only moves forward (INV-06).
  const result = await prisma.inventory.deleteMany({
    where: { id: inventory.id, storeId: Number(storeId), status: { in: ["AVAILABLE", "DAMAGED"] } },
  });

  if (result.count === 0) {
    throw inventoryError("The piece changed while you were deleting it. Please reload and try again.", 409);
  }

  return true;
};

/**
 * Gives a piece a different barcode (lost/damaged label, adopting a manufacturer tag).
 * Allowed while the piece is AVAILABLE or RESERVED; earlier codes are kept for traceability.
 */
export const changeInventoryBarcodeService = async (id, storeId, rawBarcode, actor = null) => {
  const inventory = await loadOwnInventory(id, storeId);
  if (!["AVAILABLE", "RESERVED"].includes(inventory.status)) {
    throw inventoryError(`The barcode of a ${inventory.status} piece cannot be changed.`);
  }
  const barcode = await assertPieceBarcodeFree(storeId, rawBarcode, { excludeInventoryId: inventory.id });
  if (barcode === inventory.barcodeNo) return inventory;
  const extra = inventory.extraDetails && typeof inventory.extraDetails === "object" && !Array.isArray(inventory.extraDetails) ? inventory.extraDetails : {};
  const previousBarcodes = [...(Array.isArray(extra.previousBarcodes) ? extra.previousBarcodes : []), {
    barcode: inventory.barcodeNo,
    at: new Date().toISOString(),
    by: actor ? `${actor.role || ""}:${actor.email || actor.id || ""}` : null,
  }].slice(-20);
  try {
    const result = await prisma.inventory.updateMany({
      where: { id: inventory.id, storeId: Number(storeId), status: { in: ["AVAILABLE", "RESERVED"] }, barcodeNo: inventory.barcodeNo },
      data: { barcodeNo: barcode, extraDetails: { ...extra, previousBarcodes } },
    });
    if (result.count === 0) throw inventoryError("The piece changed while you were updating it. Please reload and try again.", 409);
  } catch (error) {
    if (error?.code === "P2002") throw inventoryError(`Barcode ${barcode} is already used by another piece.`, 409);
    throw error;
  }
  return loadOwnInventory(inventory.id, storeId);
};
