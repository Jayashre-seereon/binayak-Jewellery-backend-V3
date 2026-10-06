import * as brandService from "../services/brandService.js";
import { sendError } from "../utils/errorHandler.js";

// CREATE
export const createBrand = async (req, res) => {
  try {
    const brand = await brandService.createBrand(req.body || {}, Number(req.query.storeId));
    res.status(201).json({ success: true, brand });
  } catch (err) {
    sendError(res, err, "Could not create brand.");
  }
};

// GET ALL
export const getBrands = async (req, res) => {
  try {
    const brands = await brandService.getBrands(Number(req.query.storeId));
    res.json({ success: true, brands });
  } catch (err) {
    sendError(res, err, "Could not load brands.");
  }
};

// GET BY ID
export const getBrandById = async (req, res) => {
  try {
    const brand = await brandService.getBrandById(req.params.id, Number(req.query.storeId));
    res.json({ success: true, brand });
  } catch (err) {
    sendError(res, err, "Could not load brand.");
  }
};

// UPDATE
export const updateBrand = async (req, res) => {
  try {
    const brand = await brandService.updateBrand(req.params.id, req.body || {}, Number(req.query.storeId));
    res.json({ success: true, brand });
  } catch (err) {
    sendError(res, err, "Could not update brand.");
  }
};

// DELETE
export const deleteBrand = async (req, res) => {
  try {
    await brandService.deleteBrand(req.params.id, Number(req.query.storeId));
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    sendError(res, err, "Could not delete brand.");
  }
};
