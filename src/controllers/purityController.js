import * as service from "../services/purityService.js";
import { sendError } from "../utils/errorHandler.js";

export const createPurity = async (req, res) => {
  try {
    const storeId = Number(req.query.storeId);

    const result = await service.createPurity(req.body, storeId);

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    sendError(res, err);
  }
};

export const getPurities = async (req, res) => {
  try {
    const storeId = Number(req.query.storeId);

    const data = await service.getPurities(storeId);

    res.json({ success: true, data });
  } catch (err) {
    sendError(res, err);
  }
};

export const getPurityById = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const storeId = Number(req.query.storeId);

    const data = await service.getPurityById(id, storeId);

    res.json({ success: true, data });
  } catch (err) {
    sendError(res, err);
  }
};

export const updatePurity = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const storeId = Number(req.query.storeId);

    const data = await service.updatePurity(id, req.body, storeId);

    res.json({ success: true, data });
  } catch (err) {
    sendError(res, err);
  }
};

export const deletePurity = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const storeId = Number(req.query.storeId);

    await service.deletePurity(id, storeId);

    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    sendError(res, err);
  }
};
export const getPuritiesByMetalId = async (req, res) => {
  try {
    const metalId = Number(req.params.metalId);
    const storeId = Number(req.query.storeId);

    const data = await service.getPuritiesByMetalId(
      metalId,
      storeId
    );

    res.json({
      success: true,
      data,
    });
  } catch (err) {
    sendError(res, err);
  }
};