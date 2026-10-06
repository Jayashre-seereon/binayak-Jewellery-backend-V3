/**
 * Barcode module (CONTRACT §5).
 *
 *  - Per-store scanner/label configuration (BarcodeConfig.config JSON, merged over defaults).
 *  - Scan resolution: turns whatever a scanner typed (keyboard-wedge or serial) into a
 *    billing-ready line for the sales screen.
 *  - Item codes: generate an in-store EAN-13, assign a manufacturer code, clear (MRP goods).
 *  - Piece barcodes: every Inventory piece owns a unique barcodeNo (generated at tagging or
 *    adopted from the tag the piece already carries); one availability check covers both.
 *
 * All lookups are store-scoped; nothing here ever returns another store's stock.
 */
import prisma from "../config/db.js";
import { AppError } from "../utils/validate.js";
import { findOwned } from "../utils/errorHandler.js";
import { itemInclude } from "../repositories/itemRepository.js";
import { SYMBOLOGIES, buildItemEan13, validateBarcodeValue } from "./barcode/symbology.js";

/* ------------------------------------------------------------------ config */

export const LABEL_FIELDS = ["storeName", "itemName", "productName", "purity", "grossWeight", "netWeight", "stoneWeight", "huidNo", "tagNo", "barcodeText", "price"];

export const DEFAULT_CONFIG = Object.freeze({
  deviceMode: "KEYBOARD_WEDGE", // USB / Bluetooth HID scanners type like a keyboard
  prefix: "",
  suffix: "",
  terminator: "Enter",
  minLength: 4,
  maxLength: 64,
  interKeyTimeoutMs: 50,
  autoAddToBill: true,
  beepOnScan: true,
  allowManualEntry: true,
  serialBaudRate: 9600,
  serialDataBits: 8,
  serialStopBits: 1,
  serialParity: "none",
  symbology: "CODE128",
  itemBarcodePrefix: "29",
  labelWidthMm: 50,
  labelHeightMm: 25,
  labelFields: ["storeName", "itemName", "purity", "grossWeight", "netWeight", "huidNo", "barcodeText", "price"],
});

const BAUD_RATES = [1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200];
const ENUMS = {
  deviceMode: ["KEYBOARD_WEDGE", "SERIAL"],
  terminator: ["Enter", "Tab", "None"],
  serialParity: ["none", "even", "odd", "mark", "space"],
  symbology: SYMBOLOGIES,
};
// Older/alternative key names accepted on PUT and mapped to the contract names.
const ALIASES = { scanTimeoutMs: "interKeyTimeoutMs", baudRate: "serialBaudRate", parity: "serialParity", productBarcodePrefix: "itemBarcodePrefix" };

const toBool = (v, key) => {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  throw new AppError(`${key} must be true or false.`);
};

const toInt = (v, key, min, max) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new AppError(`${key} must be a whole number between ${min} and ${max}.`);
  return n;
};

const toAffix = (v, key) => {
  const s = v === null || v === undefined ? "" : String(v);
  if (s.length > 16) throw new AppError(`${key} can be at most 16 characters.`);
  // Control characters (CR/LF/TAB) are stripped by the scanner handling anyway; keep printable only.
  if (/[\x00-\x1F\x7F]/.test(s)) throw new AppError(`${key} must contain printable characters only (Enter/Tab are set via "terminator").`);
  return s;
};

const pickEnum = (v, key) => {
  const list = ENUMS[key];
  const hit = list.find((opt) => opt.toLowerCase() === String(v ?? "").toLowerCase());
  if (!hit) throw new AppError(`${key} must be one of: ${list.join(", ")}.`);
  return hit;
};

/** Validates a partial config. Unknown keys are ignored; returns only recognised keys. */
export const validateConfigPatch = (patch = {}) => {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new AppError("Config must be an object.");
  const src = { ...patch };
  for (const [alias, key] of Object.entries(ALIASES)) {
    if (src[alias] !== undefined && src[key] === undefined) src[key] = src[alias];
  }
  const out = {};
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (src[key] === undefined) continue;
    const v = src[key];
    switch (key) {
      case "deviceMode":
      case "terminator":
      case "serialParity":
      case "symbology":
        out[key] = pickEnum(v, key);
        break;
      case "prefix":
      case "suffix":
        out[key] = toAffix(v, key);
        break;
      case "minLength":
        out[key] = toInt(v, key, 1, 128);
        break;
      case "maxLength":
        out[key] = toInt(v, key, 1, 256);
        break;
      case "interKeyTimeoutMs":
        out[key] = toInt(v, key, 5, 1000);
        break;
      case "autoAddToBill":
      case "beepOnScan":
      case "allowManualEntry":
        out[key] = toBool(v, key);
        break;
      case "serialBaudRate":
        out[key] = Number(v);
        if (!BAUD_RATES.includes(out[key])) throw new AppError(`serialBaudRate must be one of ${BAUD_RATES.join(", ")}.`);
        break;
      case "serialDataBits":
        out[key] = Number(v);
        if (![7, 8].includes(out[key])) throw new AppError("serialDataBits must be 7 or 8.");
        break;
      case "serialStopBits":
        out[key] = Number(v);
        if (![1, 2].includes(out[key])) throw new AppError("serialStopBits must be 1 or 2.");
        break;
      case "itemBarcodePrefix": {
        const p = String(v).trim();
        if (!/^2\d$/.test(p)) throw new AppError("itemBarcodePrefix must be 2 digits in the in-store range 20–29.");
        out[key] = p;
        break;
      }
      case "labelWidthMm":
        out[key] = toInt(v, key, 20, 120);
        break;
      case "labelHeightMm":
        out[key] = toInt(v, key, 10, 80);
        break;
      case "labelFields": {
        if (!Array.isArray(v)) throw new AppError("labelFields must be a list.");
        const bad = v.filter((f) => !LABEL_FIELDS.includes(f));
        if (bad.length) throw new AppError(`Unknown label field(s): ${bad.join(", ")}. Allowed: ${LABEL_FIELDS.join(", ")}.`);
        out[key] = [...new Set(v)];
        break;
      }
      default:
        break;
    }
  }
  return out;
};

/** Stored config merged over the defaults (stored values that no longer validate fall back). */
const mergeStored = (stored) => {
  let clean = {};
  try {
    clean = validateConfigPatch(stored && typeof stored === "object" ? stored : {});
  } catch {
    // Defensive: a config written by an older build that fails today's rules → per-key salvage.
    for (const [k, v] of Object.entries(stored || {})) {
      try {
        Object.assign(clean, validateConfigPatch({ [k]: v }));
      } catch {
        /* ignore invalid key */
      }
    }
  }
  return { ...DEFAULT_CONFIG, ...clean };
};

export const getBarcodeConfig = async (storeId) => {
  const row = await prisma.barcodeConfig.findUnique({ where: { storeId: Number(storeId) } });
  return mergeStored(row?.config);
};

export const updateBarcodeConfig = async (storeId, patch) => {
  const changes = validateConfigPatch(patch);
  const current = await getBarcodeConfig(storeId);
  const next = { ...current, ...changes };
  if (next.minLength > next.maxLength) throw new AppError("minLength cannot be greater than maxLength.");
  await prisma.barcodeConfig.upsert({
    where: { storeId: Number(storeId) },
    create: { storeId: Number(storeId), config: next },
    update: { config: next },
  });
  return next;
};

/* ------------------------------------------------------------------ scan */

/**
 * Normalises raw scanner output: drops control characters (CR/LF/TAB, NUL…) and
 * surrounding whitespace, then strips the configured prefix/suffix (case-insensitive).
 */
export const cleanScannedCode = (raw, config = DEFAULT_CONFIG) => {
  // eslint-disable-next-line no-control-regex
  let code = String(raw ?? "").replace(/[\x00-\x1F\x7F]/g, "").trim();
  const { prefix, suffix } = config;
  if (prefix && code.toLowerCase().startsWith(prefix.toLowerCase())) code = code.slice(prefix.length);
  if (suffix && code.toLowerCase().endsWith(suffix.toLowerCase())) code = code.slice(0, code.length - suffix.length);
  return code.trim();
};

const inventoryInclude = {
  item: { select: { id: true, name: true, barcode: true } },
  product: { select: { id: true, name: true } },
  metal: { select: { id: true, name: true } },
  purityMaster: { select: { id: true, name: true } },
  grade: { select: { id: true, name: true, percentage: true } },
  stone: { select: { id: true, name: true } },
  purchaseItem: {
    select: { id: true, makingCharges: true, stoneAmount: true, otherAmount: true, hallmarkCharges: true, extraDetails: true },
  },
};

// Field priority for a direct stock hit (CONTRACT §5).
const MATCH_FIELDS = ["barcodeNo", "tagNo", "huidNo", "inventoryCode"];

const findPieceByCode = async (storeId, code) => {
  const ci = { equals: code, mode: "insensitive" };
  const rows = await prisma.inventory.findMany({
    where: { storeId, OR: MATCH_FIELDS.map((f) => ({ [f]: ci })) },
    include: inventoryInclude,
    orderBy: { id: "desc" },
    take: 25,
  });
  if (!rows.length) return null;
  const lc = code.toLowerCase();
  for (const field of MATCH_FIELDS) {
    const hits = rows.filter((r) => String(r[field] ?? "").toLowerCase() === lc);
    if (hits.length) {
      // HUID is not unique (a piece can come back as old gold): prefer the sellable one.
      const piece = hits.find((r) => r.status === "AVAILABLE") || hits[0];
      return { piece, matchedOn: field };
    }
  }
  return null;
};

/** Latest sale rate: (metal, purity, grade) → (metal, purity, no grade) → (metal, purity, any grade). */
export const latestSaleRate = async (storeId, { metalId, purityId, gradeId }) => {
  if (!metalId || !purityId) return { rate: 0, rateSource: "NONE", rateId: null, rateDate: null };
  const base = { storeId, metalId, purityId, effectiveDate: { lte: new Date() } };
  const orderBy = [{ effectiveDate: "desc" }, { updatedAt: "desc" }, { id: "desc" }];
  const attempts = [];
  if (gradeId) attempts.push([{ ...base, gradeId }, "RATE_MASTER_GRADE"]);
  attempts.push([{ ...base, gradeId: null }, "RATE_MASTER_PURITY"]);
  attempts.push([base, "RATE_MASTER_PURITY"]);
  for (const [where, rateSource] of attempts) {
    const r = await prisma.rateMaster.findFirst({ where, orderBy, select: { id: true, saleRate: true, effectiveDate: true } });
    if (r && Number(r.saleRate) > 0) return { rate: Number(r.saleRate), rateSource, rateId: r.id, rateDate: r.effectiveDate };
  }
  return { rate: 0, rateSource: "NONE", rateId: null, rateDate: null };
};

const asObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const finite = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const MC_TYPES = ["PERCENT", "PER_GRAM", "FLAT"];

/**
 * Making-charge defaults for the bill line, from what was recorded at purchase time.
 * Never invents a percentage: no data → PERCENT 0 (the cashier types it).
 */
export const resolveMakingCharge = (piece) => {
  const ed = { ...asObject(piece.purchaseItem?.extraDetails), ...asObject(piece.extraDetails) };

  const explicitType = String(ed.makingChargeType || "").toUpperCase();
  if (MC_TYPES.includes(explicitType) && finite(ed.makingChargeRate)) {
    return { makingChargeType: explicitType, makingChargeRate: Number(ed.makingChargeRate), makingChargeSource: "PIECE" };
  }
  // Migrated pieces carry the legacy per-gram making charge.
  if (finite(ed.mkgChgPerGram)) {
    return { makingChargeType: "PER_GRAM", makingChargeRate: Number(ed.mkgChgPerGram), makingChargeSource: "LEGACY" };
  }
  const mc = Number(piece.purchaseItem?.makingCharges || 0);
  if (mc > 0 && mc <= 100) return { makingChargeType: "PERCENT", makingChargeRate: mc, makingChargeSource: "PURCHASE" };
  // A value above 100 cannot be a percentage — it is a rupee amount for the piece.
  if (mc > 100) return { makingChargeType: "FLAT", makingChargeRate: mc, makingChargeSource: "PURCHASE" };
  return { makingChargeType: "PERCENT", makingChargeRate: 0, makingChargeSource: "NONE" };
};

const buildBillingLine = async (storeId, piece) => {
  const ed = { ...asObject(piece.purchaseItem?.extraDetails), ...asObject(piece.extraDetails) };
  const rate = await latestSaleRate(storeId, piece);
  const making = resolveMakingCharge(piece);
  const itemName = piece.item?.name || null;
  const productName = piece.product?.name || null;
  const purityName = piece.purityMaster?.name || null;
  const stoneAmount = Number(piece.purchaseItem?.stoneAmount || 0) || Number(ed.stoneCost || 0) || 0;
  const otherCharges = Number(ed.otherCharges || 0) || 0;

  return {
    inventoryId: piece.id,
    itemCode: piece.barcodeNo || piece.tagNo || piece.inventoryCode,
    inventoryCode: piece.inventoryCode,
    barcodeNo: piece.barcodeNo,
    tagNo: piece.tagNo,
    particulars: itemName || productName || "Item",
    huidNo: piece.huidNo || null,
    hsnCode: piece.hsnCode || "711319",
    purityName,
    purity: piece.purity ?? piece.grade?.percentage ?? null,
    gradeName: piece.grade?.name || null,
    pieces: piece.pieces ?? 1,
    grossWeight: Number(piece.grossWeight || 0),
    stoneWeight: Number(piece.stoneWeight || 0),
    netWeight: Number(piece.netWeight || 0),
    rate: rate.rate,
    rateSource: rate.rateSource,
    rateDate: rate.rateDate,
    ...making,
    stoneAmount,
    otherCharges,
    metalId: piece.metalId,
    purityId: piece.purityId,
    gradeId: piece.gradeId,
    productId: piece.productId,
    itemId: piece.itemId,
    metalName: piece.metal?.name || null,
    productName,
    itemName,
  };
};

const publicPiece = (p) => ({
  id: p.id,
  inventoryCode: p.inventoryCode,
  barcodeNo: p.barcodeNo,
  tagNo: p.tagNo,
  huidNo: p.huidNo,
  status: p.status,
  purchaseType: p.purchaseType,
  pieces: p.pieces,
  grossWeight: p.grossWeight,
  stoneWeight: p.stoneWeight,
  netWeight: p.netWeight,
  purity: p.purity,
  hsnCode: p.hsnCode,
  itemId: p.itemId,
  productId: p.productId,
  metalId: p.metalId,
  purityId: p.purityId,
  gradeId: p.gradeId,
  item: p.item,
  product: p.product,
  metal: p.metal,
  purityMaster: p.purityMaster,
  grade: p.grade,
  stone: p.stone,
  createdAt: p.createdAt,
});

/** Error carrying extra JSON for the client (e.g. the status of a non-sellable piece). */
class ScanError extends AppError {
  constructor(message, status, details) {
    super(message, status);
    this.details = details;
  }
}

/**
 * Resolves a scanned/typed code to a sellable piece and its billing line.
 * Order: Inventory.barcodeNo → tagNo → huidNo → inventoryCode → Item.barcode
 * (item code of MRP goods → oldest AVAILABLE non-OLD piece of that item).
 */
export const scanBarcode = async (storeId, rawCode) => {
  const sid = Number(storeId);
  const config = await getBarcodeConfig(sid);
  const cleanedCode = cleanScannedCode(rawCode, config);
  if (!cleanedCode) throw new AppError("Scanned code is empty.");
  if (cleanedCode.length > 256) throw new AppError("Scanned code is too long.");

  let matchType = "INVENTORY";
  let matchedOn;
  let piece;
  let item = null;
  let notice = null;

  const direct = await findPieceByCode(sid, cleanedCode);
  if (direct) {
    ({ piece, matchedOn } = direct);
    if (piece.status !== "AVAILABLE") {
      const label = piece.barcodeNo || piece.tagNo || piece.inventoryCode;
      const tail = piece.status === "SOLD" ? "" : " and cannot be billed until it is AVAILABLE";
      throw new ScanError(`Piece ${label} is already ${piece.status}${tail}.`, 409, {
        inventoryId: piece.id,
        status: piece.status,
        code: cleanedCode,
      });
    }
    item = piece.item ? { id: piece.item.id, name: piece.item.name, barcode: piece.item.barcode ?? null } : null;
  } else {
    item = await prisma.item.findFirst({
      where: { storeId: sid, barcode: { equals: cleanedCode, mode: "insensitive" } },
      select: { id: true, name: true, barcode: true },
    });
    if (!item) throw new AppError(`No stock or item found for barcode ${cleanedCode}`, 404);
    matchType = "ITEM";
    matchedOn = "itemBarcode";
    piece = await prisma.inventory.findFirst({
      where: { storeId: sid, itemId: item.id, status: "AVAILABLE", purchaseType: { not: "OLD" } },
      include: inventoryInclude,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (!piece) {
      throw new ScanError(`Item ${item.name} (code ${cleanedCode}) has no AVAILABLE stock.`, 409, { item, code: cleanedCode });
    }
    notice = `Item code matched: piece ${piece.barcodeNo || piece.inventoryCode} picked — check its weight before billing.`;
  }

  return {
    matchType,
    matchedOn,
    code: String(rawCode ?? ""),
    cleanedCode,
    inventory: publicPiece(piece),
    item,
    notice,
    billingLine: await buildBillingLine(sid, piece),
  };
};

/* ------------------------------------------------------------------ code ownership */

/**
 * Where a code is already used in the store (case-insensitive): another item's code, or any
 * piece's barcode / tag / HUID / inventory code. Scanning resolves pieces first, so an item
 * code that equals a piece code could never be reached.
 */
export const findBarcodeOwner = async (storeId, code, { excludeItemId = null, excludeInventoryId = null } = {}) => {
  const sid = Number(storeId);
  const ci = { equals: code, mode: "insensitive" };
  const piece = await prisma.inventory.findFirst({
    where: {
      storeId: sid,
      OR: MATCH_FIELDS.filter((f) => f !== "huidNo").map((f) => ({ [f]: ci })),
      ...(excludeInventoryId ? { NOT: { id: Number(excludeInventoryId) } } : {}),
    },
    select: { id: true, inventoryCode: true, barcodeNo: true },
  });
  if (piece) return `stock piece ${piece.inventoryCode}${piece.barcodeNo && piece.barcodeNo !== code ? ` (${piece.barcodeNo})` : ""}`;
  const other = await prisma.item.findFirst({
    where: { storeId: sid, barcode: ci, ...(excludeItemId ? { NOT: { id: Number(excludeItemId) } } : {}) },
    select: { id: true, name: true },
  });
  if (other) return `item "${other.name}"`;
  return null;
};

export const assertBarcodeAvailable = async (storeId, code, opts = {}) => {
  const owner = await findBarcodeOwner(storeId, code, opts);
  if (owner) throw new AppError(`Barcode ${code} is already used by ${owner} in this store.`, 409);
};

/* ------------------------------------------------------------------ item codes */

const saveItemBarcode = async (itemId, barcode) => {
  try {
    return await prisma.item.update({ where: { id: itemId }, data: { barcode }, include: itemInclude });
  } catch (err) {
    // Lost a race with a concurrent assignment of the same code.
    if (err?.code === "P2002") throw new AppError(`Barcode ${barcode} is already assigned to another item in this store.`, 409);
    throw err;
  }
};

/** Deterministic in-store EAN-13 for an item; an existing code is kept unless `replace`. */
export const generateItemBarcode = async (storeId, itemId, { replace = false } = {}) => {
  const item = await findOwned(prisma.item, itemId, storeId, "Item", { include: itemInclude });
  if (item.barcode && !replace) return { barcode: item.barcode, item, generated: false };
  const config = await getBarcodeConfig(storeId);
  const barcode = buildItemEan13(config.itemBarcodePrefix, Number(storeId), item.id);
  if (item.barcode === barcode) return { barcode, item, generated: false };
  await assertBarcodeAvailable(storeId, barcode, { excludeItemId: item.id });
  return { barcode, item: await saveItemBarcode(item.id, barcode), generated: true };
};

/** Assigns an existing (manufacturer / supplier) code to an item. */
export const assignItemBarcode = async (storeId, itemId, rawBarcode) => {
  const item = await findOwned(prisma.item, itemId, storeId, "Item");
  const barcode = validateBarcodeValue(rawBarcode);
  if (item.barcode === barcode) {
    return { barcode, item: await findOwned(prisma.item, item.id, storeId, "Item", { include: itemInclude }) };
  }
  await assertBarcodeAvailable(storeId, barcode, { excludeItemId: item.id });
  return { barcode, item: await saveItemBarcode(item.id, barcode) };
};

export const clearItemBarcode = async (storeId, itemId) => {
  const item = await findOwned(prisma.item, itemId, storeId, "Item");
  return prisma.item.update({ where: { id: item.id }, data: { barcode: null }, include: itemInclude });
};
