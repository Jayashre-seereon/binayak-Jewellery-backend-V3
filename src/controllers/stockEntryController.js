import * as stockEntryService from "../services/stockEntryService.js";
import { sendError } from "../utils/errorHandler.js";

const storeOf = (req) => Number(req.query.storeId);

// POST /api/stock/entries
export const createStockEntry = async (req, res) => {
  try {
    const data = await stockEntryService.createStockEntry(storeOf(req), req.body || {});
    res.status(201).json({ success: true, data, message: `${data.pieces.length} piece(s) added to stock (${data.purchase.invoiceNo}).` });
  } catch (err) {
    sendError(res, err, "Could not save the stock entry.");
  }
};

// GET /api/stock/entries?page&limit&search
export const listStockEntries = async (req, res) => {
  try {
    const result = await stockEntryService.listStockEntries(storeOf(req), req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    sendError(res, err, "Could not load stock entries.");
  }
};

// DELETE /api/stock/entries/:id
export const deleteStockEntry = async (req, res) => {
  try {
    const data = await stockEntryService.deleteStockEntry(storeOf(req), req.params.id, req.user);
    res.json({ success: true, data, message: `Stock entry ${data.invoiceNo} deleted (${data.pieces} piece(s)).` });
  } catch (err) {
    sendError(res, err, "Could not delete the stock entry.");
  }
};

// GET /api/stock/barcode-check?code=
export const barcodeCheck = async (req, res) => {
  try {
    const data = await stockEntryService.checkBarcode(storeOf(req), req.query.code);
    res.json({ success: true, data });
  } catch (err) {
    sendError(res, err, "Could not check the barcode.");
  }
};
