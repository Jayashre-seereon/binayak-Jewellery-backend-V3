import express from "express";
import { createStockEntry, listStockEntries, deleteStockEntry, barcodeCheck } from "../controllers/stockEntryController.js";
import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";

const router = express.Router();
router.use(authMiddleware, requireStore);

router.get("/barcode-check", barcodeCheck);
router.get("/entries", listStockEntries);
router.post("/entries", createStockEntry);
router.delete("/entries/:id", deleteStockEntry);

export default router;
