import * as inventoryService from "../services/inventoryService.js";
import * as inventoryLabelPdfService from "../services/inventoryLabelPdfService.js";
import { safeMessage } from "../middleware/errorHandler.js";
import { MAX_LABELS_PER_REQUEST } from "../repositories/inventoryRepository.js";

const fail = (res, error, fallbackStatus, fallbackMessage) => {
  if (res.headersSent) {
    // A PDF stream had already started; it cannot be turned into a JSON error any more.
    if (!res.writableEnded) res.end();
    return undefined;
  }
  const status = error?.status || fallbackStatus;
  if (status >= 500) console.error(fallbackMessage, error);
  return res.status(status).json({ success: false, message: safeMessage(error, fallbackMessage) });
};

const requireStoreId = (req, res) => {
  const storeId = Number(req.query.storeId);
  if (!storeId) {
    res.status(400).json({ success: false, message: "Please select a store." });
    return null;
  }
  return storeId;
};

export const createInventory = async (req, res) => {
  try {
    const { purchaseItemId } = req.body || {};
    const storeId = requireStoreId(req, res);
    if (!storeId) return undefined;

    if (!purchaseItemId) {
      return res.status(400).json({
        success: false,
        message: "Please select a purchase item.",
      });
    }

    const inventory = await inventoryService.createInventoryService(purchaseItemId, storeId);

    return res.status(201).json({
      success: true,
      message: "Inventory created successfully.",
      inventory,
    });
  } catch (error) {
    return fail(res, error, 400, "Unable to create inventory. Please try again.");
  }
};

/** POST /api/inventories/create-bulk {purchaseId} or {purchaseItemIds:[...]} (INV-16). */
export const createInventoryBulk = async (req, res) => {
  try {
    const storeId = requireStoreId(req, res);
    if (!storeId) return undefined;
    const result = await inventoryService.createInventoryBulkService(storeId, req.body || {});
    return res.status(201).json({
      success: true,
      message: `${result.created.length} inventory item(s) created${result.skipped.length ? `, ${result.skipped.length} skipped` : ""}.`,
      data: result,
      inventories: result.created,
    });
  } catch (error) {
    return fail(res, error, 400, "Unable to create inventory. Please try again.");
  }
};

export const getInventories = async (req, res) => {
  try {
    const storeId = requireStoreId(req, res);
    if (!storeId) return undefined;

    const filters = {
      purchaseType: req.query.purchaseType,
      status: req.query.status,
      itemId: req.query.itemId,
      productId: req.query.productId,
      metalId: req.query.metalId,
      purityId: req.query.purityId,
      barcodeNo: req.query.barcodeNo,
      tagNo: req.query.tagNo,
      huidNo: req.query.huidNo,
      barSerialNo: req.query.barSerialNo,
    };

    const paginated = req.query.page !== undefined || req.query.limit !== undefined || req.query.search !== undefined;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 10));
    const result = await inventoryService.getInventoriesService(
      storeId, filters,
      { paginated, skip: (page - 1) * limit, take: limit, search: String(req.query.search || "").slice(0, 100) }
    );
    const inventories = paginated ? result.inventories : result;

    return res.status(200).json({
      success: true,
      count: paginated ? result.total : inventories.length,
      inventories,
      ...(paginated ? { pagination: {
        page, limit, total: result.total,
        totalPages: Math.ceil(result.total / limit),
        hasNextPage: page < Math.ceil(result.total / limit),
        hasPreviousPage: page > 1,
      } } : {}),
    });
  } catch (error) {
    return fail(res, error, 500, "Unable to load inventories right now.");
  }
};

export const getInventoryById = async (req, res) => {
  try {
    const storeId = requireStoreId(req, res);
    if (!storeId) return undefined;

    const inventory = await inventoryService.getInventoryByIdService(req.params.id, storeId);

    return res.status(200).json({
      success: true,
      inventory,
    });
  } catch (error) {
    return fail(res, error, 404, "Inventory record not found.");
  }
};

export const getInventoryByBarcode = async (req, res) => {
  try {
    const { barcodeNo } = req.params;
    const storeId = requireStoreId(req, res);
    if (!storeId) return undefined;

    if (!barcodeNo) {
      return res.status(400).json({
        success: false,
        message: "Please enter a barcode number.",
      });
    }

    const inventory = await inventoryService.getInventoryByBarcodeService(barcodeNo, storeId);

    return res.status(200).json({
      success: true,
      inventory,
    });
  } catch (error) {
    return fail(res, error, 404, "Inventory record not found.");
  }
};

export const updateInventory = async (req, res) => {
  try {
    const storeId = requireStoreId(req, res);
    if (!storeId) return undefined;

    const inventory = await inventoryService.updateInventoryService(req.params.id, storeId, req.body);

    return res.status(200).json({
      success: true,
      message: "Inventory updated successfully.",
      inventory,
    });
  } catch (error) {
    return fail(res, error, 400, "Unable to update inventory. Please try again.");
  }
};

export const updateInventoryStatus = async (req, res) => {
  try {
    const { status } = req.body || {};
    const storeId = requireStoreId(req, res);
    if (!storeId) return undefined;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: "Please select an inventory status.",
      });
    }

    const inventory = await inventoryService.updateInventoryStatusService(req.params.id, storeId, status, req.user);

    return res.status(200).json({
      success: true,
      message: "Inventory status updated successfully.",
      inventory,
    });
  } catch (error) {
    return fail(res, error, 400, "Unable to update inventory status. Please try again.");
  }
};

export const deleteInventory = async (req, res) => {
  try {
    const storeId = requireStoreId(req, res);
    if (!storeId) return undefined;

    await inventoryService.deleteInventoryService(req.params.id, storeId);

    return res.status(200).json({
      success: true,
      message: "Inventory deleted successfully.",
    });
  } catch (error) {
    return fail(res, error, 400, "Unable to delete inventory. Please try again.");
  }
};

export const printInventoryLabel = async (req, res) => {
  try {
    const storeId = requireStoreId(req, res);
    if (!storeId) return undefined;

    await inventoryLabelPdfService.generateInventoryLabelPdf(req.params.id, storeId, res);
    return undefined;
  } catch (error) {
    return fail(res, error, 400, "Unable to print the inventory label.");
  }
};

const countRequested = (body = {}) => {
  const ids = new Set();
  const codes = new Set();
  for (const k of ["ids", "inventoryIds", "idList", "selectedIds"]) if (Array.isArray(body[k])) body[k].forEach((v) => ids.add(String(v)));
  for (const k of ["barcodeNos", "barcodes", "selectedBarcodes"]) if (Array.isArray(body[k])) body[k].forEach((v) => codes.add(String(v)));
  return ids.size + codes.size;
};

export const printBulkInventoryLabels = async (req, res) => {
  try {
    const storeId = requireStoreId(req, res);
    if (!storeId) return undefined;

    // INV-22: cap the size of one label job.
    if (countRequested(req.body || {}) > MAX_LABELS_PER_REQUEST) {
      return res.status(400).json({
        success: false,
        message: `At most ${MAX_LABELS_PER_REQUEST} labels can be printed in one request.`,
      });
    }

    await inventoryLabelPdfService.generateBulkInventoryLabelsPdf(req.body, storeId, res);
    return undefined;
  } catch (error) {
    return fail(res, error, 400, "Unable to print inventory labels.");
  }
};

/** PUT /api/inventories/:id/barcode { barcode } — re-label an AVAILABLE/RESERVED piece. */
export const changeInventoryBarcode = async (req, res) => {
  try {
    const storeId = requireStoreId(req, res);
    if (!storeId) return undefined;
    const inventory = await inventoryService.changeInventoryBarcodeService(req.params.id, storeId, req.body?.barcode, req.user);
    return res.json({ success: true, message: `Barcode changed to ${inventory.barcodeNo}.`, data: inventory, inventory });
  } catch (error) {
    return fail(res, error, 400, "Unable to change the barcode.");
  }
};
