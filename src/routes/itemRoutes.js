import express from "express";
import {
  createItem,
  getItems,
  getItemOptions,
  getItemsByProductId,
  getItemById,
  updateItem,
  deleteItem,
} from "../controllers/itemController.js";
import { generateItemBarcode, assignItemBarcode, clearItemBarcode, itemLabel } from "../controllers/barcodeController.js";
import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";
import { upload } from "../middleware/uploadS3.js";

const router = express.Router();

router.use(authMiddleware, requireStore);

// Static paths first (before any "/:id"-style route).
router.get("/options", getItemOptions);
router.post("/create", upload.single("image"), createItem);
router.get("/get", getItems);
router.get("/getByProduct/:productId", getItemsByProductId);
router.get("/getById/:id", getItemById);
router.put("/update/:id", upload.single("image"), updateItem);
router.delete("/delete/:id", deleteItem);

// Item codes (MRP goods). Each piece's own barcode lives on the Inventory row.
router.post("/:id/barcode/generate", generateItemBarcode);
router.put("/:id/barcode", assignItemBarcode);
router.delete("/:id/barcode", clearItemBarcode);
router.get("/:id/barcode/label", itemLabel);

export default router;
