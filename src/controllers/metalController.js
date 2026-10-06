import * as metalService from "../services/metalService.js";
import { sendError } from "../utils/errorHandler.js";

// CREATE
export const createMetal = async (req, res) => {
  try {
    const metal = await metalService.createMetal(req.body || {}, Number(req.query.storeId));
    res.status(201).json({ success: true, metal });
  } catch (err) {
    sendError(res, err, "Could not create metal.");
  }
};

// GET ALL
export const getMetals = async (req, res) => {
  try {
    const metals = await metalService.getMetals(Number(req.query.storeId));
    res.json({ success: true, metals });
  } catch (err) {
    sendError(res, err, "Could not load metals.");
  }
};

// GET BY ID
export const getMetalById = async (req, res) => {
  try {
    const metal = await metalService.getMetalById(req.params.id, Number(req.query.storeId));
    res.json({ success: true, metal });
  } catch (err) {
    sendError(res, err, "Could not load metal.");
  }
};

// UPDATE
export const updateMetal = async (req, res) => {
  try {
    const metal = await metalService.updateMetal(req.params.id, req.body || {}, Number(req.query.storeId));
    res.json({ success: true, metal });
  } catch (err) {
    sendError(res, err, "Could not update metal.");
  }
};

// DELETE
export const deleteMetal = async (req, res) => {
  try {
    await metalService.deleteMetal(req.params.id, Number(req.query.storeId));
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    sendError(res, err, "Could not delete metal.");
  }
};
