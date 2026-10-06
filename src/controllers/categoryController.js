import * as categoryService from "../services/CategoryService.js";
import { sendError } from "../utils/errorHandler.js";

// CREATE
export const createCategory = async (req, res) => {
  try {
    const category = await categoryService.createCategory(req.body || {}, Number(req.query.storeId));
    res.status(201).json({ success: true, category });
  } catch (err) {
    sendError(res, err, "Could not create category.");
  }
};

// GET ALL
export const getCategories = async (req, res) => {
  try {
    const categories = await categoryService.getCategories(Number(req.query.storeId));
    res.json({ success: true, categories });
  } catch (err) {
    sendError(res, err, "Could not load categories.");
  }
};

// GET BY ID
export const getCategoryById = async (req, res) => {
  try {
    const category = await categoryService.getCategoryById(req.params.id, Number(req.query.storeId));
    res.json({ success: true, category });
  } catch (err) {
    sendError(res, err, "Could not load category.");
  }
};

// UPDATE
export const updateCategory = async (req, res) => {
  try {
    const category = await categoryService.updateCategory(req.params.id, req.body || {}, Number(req.query.storeId));
    res.json({ success: true, category });
  } catch (err) {
    sendError(res, err, "Could not update category.");
  }
};

// DELETE
export const deleteCategory = async (req, res) => {
  try {
    await categoryService.deleteCategory(req.params.id, Number(req.query.storeId));
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    sendError(res, err, "Could not delete category.");
  }
};
