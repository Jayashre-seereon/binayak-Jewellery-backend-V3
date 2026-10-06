import * as itemService from "../services/itemService.js";
import { sendError } from "../utils/errorHandler.js";

// Create Item
export const createItem = async (req, res) => {
  try {
    const image = req.file ? req.file.location : null;
    const item = await itemService.createItem({ ...(req.body || {}), image }, Number(req.query.storeId));
    res.status(201).json({ success: true, item });
  } catch (err) {
    sendError(res, err, "Could not create item.");
  }
};

// Get All Items (paginated)
export const getItems = async (req, res) => {
  try {
    const result = await itemService.getItems(
      Number(req.query.storeId),
      req.query.page,
      req.query.limit,
      String(req.query.search || "")
    );
    res.status(200).json({ success: true, items: result.items, pagination: result.pagination });
  } catch (err) {
    sendError(res, err, "Could not load items.");
  }
};

// GET /api/items/options?search= — all items, lean, for dropdowns
export const getItemOptions = async (req, res) => {
  try {
    const data = await itemService.getItemOptions(Number(req.query.storeId), req.query.search);
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendError(res, err, "Could not load item options.");
  }
};

// Get Items By Product Id
export const getItemsByProductId = async (req, res) => {
  try {
    const items = await itemService.getItemsByProductId(req.params.productId, Number(req.query.storeId));
    res.status(200).json({ success: true, items });
  } catch (err) {
    sendError(res, err, "Could not load items.");
  }
};

// Get Item By Id
export const getItemById = async (req, res) => {
  try {
    const item = await itemService.getItemById(req.params.id, Number(req.query.storeId));
    res.status(200).json({ success: true, item });
  } catch (err) {
    sendError(res, err, "Could not load item.");
  }
};

// Update Item
export const updateItem = async (req, res) => {
  try {
    const image = req.file ? req.file.location : undefined;
    const item = await itemService.updateItem(req.params.id, { ...(req.body || {}), image }, Number(req.query.storeId));
    res.status(200).json({ success: true, item });
  } catch (err) {
    sendError(res, err, "Could not update item.");
  }
};

// Delete Item
export const deleteItem = async (req, res) => {
  try {
    await itemService.deleteItem(req.params.id, Number(req.query.storeId));
    res.status(200).json({ success: true, message: "Item deleted successfully" });
  } catch (err) {
    sendError(res, err, "Could not delete item.");
  }
};
