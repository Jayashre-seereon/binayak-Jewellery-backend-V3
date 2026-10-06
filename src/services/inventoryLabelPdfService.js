// Jewellery tag labels (100 x 70 pt = approx. 35 x 25 mm).
// Single label: one label per page. Bulk: A4 sheet, 5 x 11 labels per page.
// Barcodes are Code 128 drawn as vector bars (crisp at any printer resolution), and every
// label is encoded before anything is sent, so a bad legacy code returns a clean 400.
import PDFDocument from "pdfkit";
import bwipjs from "bwip-js";
import prisma from "../config/db.js";
import { publicStoreSelect } from "../utils/publicSelect.js";
import { AppError } from "../utils/validate.js";
import { registerFonts, sendPdf } from "./documents/engine.js";
import { clean, num, upper, weight } from "./documents/format.js";

const LABEL_WIDTH = 100;
const LABEL_HEIGHT = 70;

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const GAP_X = 4;
const GAP_Y = 1;
const COLS = 5;
const ROWS = 11;
const LABELS_PER_PAGE = COLS * ROWS;
const MAX_BULK_LABELS = LABELS_PER_PAGE * 40;

const INK = "#111111";
const MUTED = "#444444";

const labelInclude = {
  store: { select: publicStoreSelect },
  item: true,
  product: true,
  metal: true,
  purityMaster: true,
};

const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

/** Encodes Code 128 bars; returns null if the value cannot be encoded. */
const encodeCode128 = (value) => {
  const text = String(value || "").trim();
  if (!text || text.length > 48 || !PRINTABLE_ASCII.test(text)) return null;
  try {
    const [symbol] = bwipjs.raw("code128", text, "");
    if (!symbol?.sbs?.length) return null;
    return { text, bars: symbol.sbs, modules: symbol.sbs.reduce((s, w) => s + w, 0) };
  } catch {
    return null;
  }
};

const purityText = (inv) => {
  const name = clean(inv.purityMaster?.name) || (num(inv.purity) > 0 ? String(inv.purity) : "");
  return name.replace(/\s*carats?$/i, "K").replace(/^(\d+)\s+K$/i, "$1K");
};

/** Everything a label needs, resolved up front (throws before any output is produced). */
const prepareLabel = (inv) => {
  const candidates = [inv.barcodeNo, inv.tagNo, inv.inventoryCode].map(clean).filter(Boolean);
  let barcode = null;
  for (const code of candidates) {
    barcode = encodeCode128(code);
    if (barcode) break;
  }
  if (!barcode) {
    throw new AppError(`Piece ${clean(inv.inventoryCode) || inv.id} has no printable barcode or tag number`, 400);
  }
  const tag = clean(inv.tagNo);
  return {
    store: upper(inv.store?.storeName),
    item: upper(inv.item?.name) || upper(inv.product?.name) || upper(inv.metal?.name) || "-",
    purity: purityText(inv),
    gross: num(inv.grossWeight),
    net: num(inv.netWeight),
    huid: upper(inv.huidNo),
    tag: tag && tag !== barcode.text ? tag : "",
    barcode,
  };
};

const fitText = (doc, text, width) => {
  let value = String(text || "");
  if (doc.widthOfString(value) <= width) return value;
  while (value.length > 1 && doc.widthOfString(`${value}…`) > width) value = value.slice(0, -1);
  return `${value}…`;
};

const line = (doc, fonts, text, x, y, width, { kind = "regular", size = 6, align = "left", color = INK, spacing = 0 } = {}) => {
  doc.font(fonts[kind]).fontSize(size).fillColor(color);
  doc.text(fitText(doc, text, width), x, y, { width, align, lineBreak: false, characterSpacing: spacing });
};

// Six modules of quiet zone are kept on each side inside the label.
const QUIET_MODULES = 6;

const drawBars = (doc, barcode, x, y, maxWidth, height) => {
  const module = Math.min(1.1, maxWidth / (barcode.modules + QUIET_MODULES * 2));
  const total = module * barcode.modules;
  let cx = x + (maxWidth - total) / 2;
  doc.save().fillColor("#000000");
  barcode.bars.forEach((units, index) => {
    const w = units * module;
    if (index % 2 === 0) doc.rect(cx, y, w, height).fill();
    cx += w;
  });
  doc.restore();
};

/** Draws one tag inside the 100 x 70 box at (x, y). */
const drawLabel = (doc, fonts, label, x, y) => {
  const pad = 4;
  const inner = LABEL_WIDTH - pad * 2;
  const left = x + pad;

  const purityW = label.purity ? Math.min(30, doc.font(fonts.bold).fontSize(6.4).widthOfString(label.purity) + 1) : 0;
  line(doc, fonts, label.store, left, y + 3.2, inner - purityW - 3, { kind: "bold", size: 5.4, color: MUTED, spacing: 0.3 });
  if (label.purity) line(doc, fonts, label.purity, left, y + 2.6, inner, { kind: "bold", size: 6.4, align: "right" });

  line(doc, fonts, label.item, left, y + 10.2, inner, { kind: "bold", size: 7 });

  line(doc, fonts, `GW ${weight(label.gross)}`, left, y + 18.6, inner / 2, { size: 6 });
  line(doc, fonts, `NW ${weight(label.net)}`, left + inner / 2, y + 18.6, inner / 2, { size: 6, align: "right" });

  const idParts = [label.huid ? `HUID ${label.huid}` : "", label.tag ? `TAG ${label.tag}` : ""].filter(Boolean);
  if (idParts.length) line(doc, fonts, idParts.join("  "), left, y + 25.6, inner, { size: 5.4, color: MUTED });

  const barTop = y + (idParts.length ? 33 : 29);
  const barHeight = y + 57 - barTop;
  drawBars(doc, label.barcode, x + 1, barTop, LABEL_WIDTH - 2, barHeight);
  line(doc, fonts, label.barcode.text, left, y + 59.2, inner, { kind: "bold", size: 6.6, align: "center", spacing: 0.8 });
};

const render = (doc) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });

export const generateInventoryLabelPdf = async (id, storeId, res) => {
  const inventory = await prisma.inventory.findFirst({
    where: { id: Number(id), storeId: Number(storeId) },
    include: labelInclude,
  });
  if (!inventory) throw new AppError("Inventory not found for this store", 404);
  const label = prepareLabel(inventory);

  const doc = new PDFDocument({ size: [LABEL_WIDTH, LABEL_HEIGHT], margins: { top: 0, bottom: 0, left: 0, right: 0 }, info: { Title: `Tag ${label.barcode.text}` } });
  const fonts = registerFonts(doc);
  drawLabel(doc, fonts, label, 0, 0);
  const buffer = await render(doc);
  sendPdf(res, buffer, `inventory-label-${clean(inventory.tagNo) || clean(inventory.inventoryCode) || inventory.id}.pdf`, "attachment");
};

const normalizeLabelRequest = (payload = {}) => {
  const ids = [];
  const barcodeNos = [];
  for (const value of [payload.ids, payload.inventoryIds, payload.idList, payload.selectedIds]) {
    if (Array.isArray(value)) ids.push(...value);
  }
  for (const value of [payload.barcodeNos, payload.barcodes, payload.selectedBarcodes]) {
    if (Array.isArray(value)) barcodeNos.push(...value);
  }
  if (payload.id !== undefined && payload.id !== null) ids.push(payload.id);
  if (payload.barcodeNo !== undefined && payload.barcodeNo !== null) barcodeNos.push(payload.barcodeNo);
  return {
    ids: [...new Set(ids.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0))],
    barcodeNos: [...new Set(barcodeNos.map((v) => String(v).trim()).filter(Boolean))],
  };
};

export const generateBulkInventoryLabelsPdf = async (payload, storeId, res) => {
  const { ids, barcodeNos } = normalizeLabelRequest(payload || {});
  if (ids.length === 0 && barcodeNos.length === 0) {
    throw new AppError("At least one inventory id or barcodeNo is required", 400);
  }
  if (ids.length + barcodeNos.length > MAX_BULK_LABELS) {
    throw new AppError(`Please print at most ${MAX_BULK_LABELS} labels at a time`, 400);
  }

  const found = await prisma.inventory.findMany({
    where: {
      storeId: Number(storeId),
      OR: [...(ids.length ? [{ id: { in: ids } }] : []), ...(barcodeNos.length ? [{ barcodeNo: { in: barcodeNos } }] : [])],
    },
    include: labelInclude,
  });
  if (found.length === 0) throw new AppError("No inventories found for the provided ids or barcode numbers", 404);

  // Keep the order the user selected (ids first, then barcodes), each piece once.
  const byId = new Map(found.map((inv) => [inv.id, inv]));
  const byBarcode = new Map(found.map((inv) => [clean(inv.barcodeNo), inv]));
  const ordered = [];
  const seen = new Set();
  for (const inv of [...ids.map((i) => byId.get(i)), ...barcodeNos.map((b) => byBarcode.get(b))]) {
    if (inv && !seen.has(inv.id)) {
      seen.add(inv.id);
      ordered.push(inv);
    }
  }
  const labels = ordered.map(prepareLabel);

  const doc = new PDFDocument({ size: "A4", margins: { top: 0, bottom: 0, left: 0, right: 0 }, info: { Title: "Inventory labels" } });
  const fonts = registerFonts(doc);
  const totalWidth = COLS * LABEL_WIDTH + (COLS - 1) * GAP_X;
  const totalHeight = ROWS * LABEL_HEIGHT + (ROWS - 1) * GAP_Y;
  const startX = (A4_WIDTH - totalWidth) / 2;
  const startY = (A4_HEIGHT - totalHeight) / 2;

  labels.forEach((label, index) => {
    const position = index % LABELS_PER_PAGE;
    if (index > 0 && position === 0) doc.addPage({ size: "A4", margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    const row = Math.floor(position / COLS);
    const col = position % COLS;
    drawLabel(doc, fonts, label, startX + col * (LABEL_WIDTH + GAP_X), startY + row * (LABEL_HEIGHT + GAP_Y));
  });

  const buffer = await render(doc);
  sendPdf(res, buffer, `inventory-labels-${Date.now()}.pdf`, "attachment");
};
