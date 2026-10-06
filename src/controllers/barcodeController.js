import prisma from "../config/db.js";
import * as barcodeService from "../services/barcodeService.js";
import { renderBarcodePng, pickSymbology, SYMBOLOGIES } from "../services/barcode/symbology.js";
import { buildItemLabelPdf } from "../services/barcode/labelPdf.js";
import { findOwned, sendError } from "../utils/errorHandler.js";
import { AppError } from "../utils/validate.js";

const storeOf = (req) => Number(req.query.storeId);

// Like sendError, but forwards `details` (e.g. status of a non-sellable piece) as `data`.
const fail = (res, err, fallback) => {
  if (err?.details && err.status && err.status < 500) {
    return res.status(err.status).json({ success: false, message: err.message, error: err.message, data: err.details });
  }
  return sendError(res, err, fallback);
};

/* ---------------------------------------------------------------- config */

export const getConfig = async (req, res) => {
  try {
    const data = await barcodeService.getBarcodeConfig(storeOf(req));
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err, "Could not load barcode settings.");
  }
};

export const updateConfig = async (req, res) => {
  try {
    const data = await barcodeService.updateBarcodeConfig(storeOf(req), req.body || {});
    res.json({ success: true, data, message: "Barcode settings saved." });
  } catch (err) {
    fail(res, err, "Could not save barcode settings.");
  }
};

/* ---------------------------------------------------------------- scan */

// GET /api/barcode/scan/:code  (also accepts ?code= for values containing "/")
export const scan = async (req, res) => {
  try {
    const code = req.params.code ?? req.query.code;
    const data = await barcodeService.scanBarcode(storeOf(req), code);
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err, "Could not resolve the scanned code.");
  }
};

/* ---------------------------------------------------------------- image */

// GET /api/barcode/image/:code?symbology=CODE128|EAN13|QRCODE&scale=3&height=12&includeText=1
export const image = async (req, res) => {
  try {
    const code = String(req.params.code ?? req.query.code ?? "").trim();
    const requested = req.query.symbology ? String(req.query.symbology).toUpperCase() : "AUTO";
    if (requested !== "AUTO" && !SYMBOLOGIES.includes(requested)) {
      throw new AppError(`symbology must be one of ${SYMBOLOGIES.join(", ")}.`);
    }
    // Explicit EAN13 is honoured strictly (invalid → 400); AUTO picks EAN-13 for valid numbers.
    const symbology = requested === "EAN13" ? "EAN13" : pickSymbology(code, requested);
    const includeText = !["0", "false", "no"].includes(String(req.query.includeText ?? "1").toLowerCase());
    const png = await renderBarcodePng(code, {
      symbology,
      scale: req.query.scale ?? 3,
      height: req.query.height ?? 12,
      includeText,
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("Content-Length", png.length);
    res.end(png);
  } catch (err) {
    fail(res, err, "Could not render barcode.");
  }
};

/* ---------------------------------------------------------------- item codes */

// POST /api/items/:id/barcode/generate  { replace?: true }
export const generateItemBarcode = async (req, res) => {
  try {
    const replace = [true, "true", 1, "1"].includes(req.body?.replace ?? req.query.replace);
    const { barcode, item, generated } = await barcodeService.generateItemBarcode(storeOf(req), req.params.id, { replace });
    res.status(generated ? 201 : 200).json({
      success: true,
      data: { barcode, item, generated },
      message: generated ? "Item code generated." : "Item already has this code.",
    });
  } catch (err) {
    fail(res, err, "Could not generate the item code.");
  }
};

// PUT /api/items/:id/barcode  { barcode }
export const assignItemBarcode = async (req, res) => {
  try {
    const data = await barcodeService.assignItemBarcode(storeOf(req), req.params.id, req.body?.barcode);
    res.json({ success: true, data, message: "Item code saved." });
  } catch (err) {
    fail(res, err, "Could not save the item code.");
  }
};

// DELETE /api/items/:id/barcode
export const clearItemBarcode = async (req, res) => {
  try {
    const item = await barcodeService.clearItemBarcode(storeOf(req), req.params.id);
    res.json({ success: true, data: item, message: "Item code removed." });
  } catch (err) {
    fail(res, err, "Could not remove the item code.");
  }
};

// GET /api/items/:id/barcode/label?copies=N  → PDF (one label per page)
export const itemLabel = async (req, res) => {
  try {
    const storeId = storeOf(req);
    const copies = req.query.copies === undefined ? 1 : Number(req.query.copies);
    if (!Number.isInteger(copies) || copies < 1 || copies > 200) throw new AppError("copies must be a whole number from 1 to 200.");

    const item = await findOwned(prisma.item, req.params.id, storeId, "Item", {
      include: { product: { select: { name: true } }, purity: { select: { name: true } } },
    });
    if (!item.barcode) throw new AppError("This item has no item code yet. Generate or assign one first.", 409);

    const [store, config] = await Promise.all([
      prisma.store.findUnique({ where: { id: storeId }, select: { storeName: true } }),
      barcodeService.getBarcodeConfig(storeId),
    ]);
    const pdf = await buildItemLabelPdf({
      code: item.barcode,
      storeName: store?.storeName || "",
      itemName: item.name,
      subtitle: [item.product?.name, item.purity?.name].filter(Boolean).join(" "),
      copies,
      config,
    });
    const safeName = String(item.barcode).replace(/[^A-Za-z0-9_-]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="label-${safeName}.pdf"`);
    res.setHeader("Content-Length", pdf.length);
    res.end(pdf);
  } catch (err) {
    fail(res, err, "Could not create labels.");
  }
};
