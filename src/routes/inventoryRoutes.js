import express from "express";

import {
  createInventory,
  createInventoryBulk,
  getInventories,
  getInventoryById,
  getInventoryByBarcode,
  updateInventory,
  updateInventoryStatus,
  printInventoryLabel,
  printBulkInventoryLabels,
  deleteInventory,
  changeInventoryBarcode,
} from "../controllers/inventoryController.js";

import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/create", authMiddleware, requireStore, createInventory);
router.post("/create-bulk", authMiddleware, requireStore, createInventoryBulk);

router.get("/get", authMiddleware, requireStore, getInventories);

router.get("/getById/:id", authMiddleware, requireStore, getInventoryById);
router.get("/getByBarcode/:barcodeNo", authMiddleware, requireStore, getInventoryByBarcode);

router.get("/label/:id", authMiddleware, requireStore, printInventoryLabel);
router.post("/labels/bulk", authMiddleware, requireStore, printBulkInventoryLabels);

router.put("/update/:id", authMiddleware, requireStore, updateInventory);
router.put("/:id/barcode", authMiddleware, requireStore, changeInventoryBarcode);

router.put(
  "/status/:id",
  authMiddleware,
  requireStore,
  updateInventoryStatus
);

router.delete("/delete/:id", authMiddleware, requireStore, deleteInventory);

export default router;
