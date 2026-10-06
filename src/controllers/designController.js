import * as designService from "../services/designService.js";
import { sendError } from "../utils/errorHandler.js";

// CREATE
export const createDesign = async (req, res) => {
  try {
    const image = req.file ? req.file.location : null;
    const design = await designService.createDesign({ ...(req.body || {}), image }, Number(req.query.storeId));
    res.status(201).json({ success: true, design });
  } catch (err) {
    sendError(res, err, "Could not create design.");
  }
};

// GET ALL
export const getDesigns = async (req, res) => {
  try {
    const designs = await designService.getDesigns(Number(req.query.storeId));
    res.json({ success: true, designs });
  } catch (err) {
    sendError(res, err, "Could not load designs.");
  }
};

// GET BY ID
export const getDesignById = async (req, res) => {
  try {
    const design = await designService.getDesignById(req.params.id, Number(req.query.storeId));
    res.json({ success: true, design });
  } catch (err) {
    sendError(res, err, "Could not load design.");
  }
};

// UPDATE
export const updateDesign = async (req, res) => {
  try {
    const image = req.file ? req.file.location : undefined;
    const design = await designService.updateDesign(req.params.id, { ...(req.body || {}), image }, Number(req.query.storeId));
    res.json({ success: true, design });
  } catch (err) {
    sendError(res, err, "Could not update design.");
  }
};

// DELETE
export const deleteDesign = async (req, res) => {
  try {
    await designService.deleteDesign(req.params.id, Number(req.query.storeId));
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    sendError(res, err, "Could not delete design.");
  }
};
