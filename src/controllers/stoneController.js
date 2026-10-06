import * as stoneService from "../services/stoneService.js";
import { sendError } from "../utils/errorHandler.js";

export const createStone = async (req, res) => {
  try {
    const stone = await stoneService.createStone(
      req.body || {},
      Number(req.query.storeId)
    );

    res.status(201).json({
      success: true,
      stone,
    });
  } catch (err) {
    sendError(res, err);
  }
};

export const getStones = async (req, res) => {
  try {
    const stones = await stoneService.getStones(
      Number(req.query.storeId)
    );

    res.json({
      success: true,
      stones,
    });
  } catch (err) {
    sendError(res, err);
  }
};

export const getStonesByProductIdAndItemId = async (req, res) => {
  try {
    const stones = await stoneService.getStonesByProductIdAndItemId(
      Number(req.params.productId),
      Number(req.params.itemId),
      Number(req.query.storeId)
    );

    res.json({
      success: true,
      stones,
    });
  } catch (err) {
    sendError(res, err);
  }
};

export const getStoneById = async (req, res) => {
  try {
    const stone = await stoneService.getStoneById(
      Number(req.params.id),
      Number(req.query.storeId)
    );

    res.json({
      success: true,
      stone,
    });
  } catch (err) {
    sendError(res, err);
  }
};

export const updateStone = async (req, res) => {
  try {
    const stone = await stoneService.updateStone(
      Number(req.params.id),
      req.body || {},
      Number(req.query.storeId)
    );

    res.json({
      success: true,
      stone,
    });
  } catch (err) {
    sendError(res, err);
  }
};

export const deleteStone = async (req, res) => {
  try {
    await stoneService.deleteStone(
      Number(req.params.id),
      Number(req.query.storeId)
    );

    res.json({
      success: true,
      message: "Stone deleted successfully",
    });
  } catch (err) {
    sendError(res, err);
  }
};
