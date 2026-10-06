import * as transferService from "../services/inventoryTransferService.js";
import { safeMessage } from "../middleware/errorHandler.js";
import { AppError } from "../utils/validate.js";

const fail = (res, error, fallbackStatus, fallbackMessage) => {
  const status = error?.status || fallbackStatus;
  if (status >= 500) console.error(fallbackMessage, error);
  return res.status(status).json({ success: false, message: safeMessage(error, fallbackMessage) });
};

/**
 * The store this request acts as. STORE logins are pinned to their own store by authMiddleware
 * (req.storeId). An ADMIN acts as the store chosen with ?storeId=, or else the store named in the
 * body field `bodyKey`; if both are given they must match (INV-01).
 */
const actingStoreId = (req, bodyKey) => {
  if (!req.user) throw new AppError("Authentication required", 401);
  const fromBody = req.body && req.body[bodyKey] !== undefined && req.body[bodyKey] !== "" ? Number(req.body[bodyKey]) : null;

  if (req.user.role === "STORE") {
    const own = Number(req.storeId);
    if (fromBody !== null && fromBody !== own) throw new AppError("You can only act for your own store.", 403);
    return own;
  }
  if (req.user.role === "ADMIN") {
    const chosen = req.storeId ? Number(req.storeId) : null;
    if (chosen && fromBody !== null && fromBody !== chosen) throw new AppError(`${bodyKey} does not match the selected store.`, 400);
    const id = chosen || fromBody;
    if (!id || !Number.isInteger(id) || id <= 0) throw new AppError("Please select a store.");
    return id;
  }
  throw new AppError("Not authorized", 403);
};

export const createInventoryTransfer = async (req, res) => {
  try {
    const { toStoreId, inventoryIds, narration } = req.body || {};
    const fromStoreId = actingStoreId(req, "fromStoreId");

    if (!toStoreId) {
      return res.status(400).json({
        success: false,
        message: "toStoreId is required",
      });
    }

    const transfer = await transferService.createTransferService({
      fromStoreId,
      toStoreId: Number(toStoreId),
      inventoryIds,
      narration,
    });

    return res.status(201).json({
      success: true,
      message: "Inventory transfer created successfully",
      transfer,
    });
  } catch (error) {
    return fail(res, error, 400, "Unable to create the transfer.");
  }
};

export const getInventoryTransfers = async (req, res) => {
  try {
    // STORE: own transfers only. ADMIN: the selected store, or all when none is selected.
    const storeId = req.user.role === "STORE" ? Number(req.storeId) : req.storeId ? Number(req.storeId) : null;

    const transfers = await transferService.getTransfersService({
      storeId,
      status: req.query.status,
    });

    return res.status(200).json({
      success: true,
      count: transfers.length,
      transfers,
    });
  } catch (error) {
    return fail(res, error, 500, "Unable to load transfers.");
  }
};

export const getInventoryTransferById = async (req, res) => {
  try {
    const transfer = await transferService.getTransferByIdService(req.params.id);

    if (req.user.role === "STORE") {
      const storeId = Number(req.storeId);
      if (Number(transfer.fromStoreId) !== storeId && Number(transfer.toStoreId) !== storeId) {
        return res.status(404).json({
          success: false,
          message: "Inventory transfer not found",
        });
      }
    }

    return res.status(200).json({
      success: true,
      transfer,
    });
  } catch (error) {
    return fail(res, error, 404, "Inventory transfer not found");
  }
};

export const updateInventoryTransfer = async (req, res) => {
  try {
    const fromStoreId = actingStoreId(req, "fromStoreId");
    const { toStoreId, inventoryIds, narration } = req.body || {};

    const transfer = await transferService.updateTransferService({
      transferId: req.params.id,
      fromStoreId,
      toStoreId,
      inventoryIds,
      narration,
    });

    return res.status(200).json({
      success: true,
      message: "Inventory transfer updated successfully",
      transfer,
    });
  } catch (error) {
    return fail(res, error, 400, "Unable to update the transfer.");
  }
};

export const receiveInventoryTransfer = async (req, res) => {
  try {
    const toStoreId = actingStoreId(req, "toStoreId");

    const transfer = await transferService.receiveTransferService({
      transferId: req.params.id,
      toStoreId,
    });

    return res.status(200).json({
      success: true,
      message: transfer.relabelRequired
        ? "Inventory transfer received. Some pieces got new barcodes - please reprint their labels."
        : "Inventory transfer received successfully",
      transfer,
    });
  } catch (error) {
    return fail(res, error, 400, "Unable to receive the transfer.");
  }
};

export const cancelInventoryTransfer = async (req, res) => {
  try {
    const storeId = actingStoreId(req, "storeId");

    const transfer = await transferService.cancelTransferService({
      transferId: req.params.id,
      storeId,
    });

    return res.status(200).json({
      success: true,
      message: "Inventory transfer cancelled successfully",
      transfer,
    });
  } catch (error) {
    return fail(res, error, 400, "Unable to cancel the transfer.");
  }
};
