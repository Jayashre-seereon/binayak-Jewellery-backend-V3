import express from "express";
import { upload } from "../middleware/uploadS3.js";  // CHANGED - use your S3 multer config

import {
  createPurchase,
  getPurchases,
  getPurchaseById,
  getPurchaseItemsByPurchaseId,
  getOldGoldPurchasesByPhone,
  updatePurchase,
  deletePurchase,
  getPurchaseCount,
  getPurchaseReport,
  exportPurchaseReportExcel,
  exportPurchaseReportPdf,
  downloadPurchasePdf,
  getPurchasesPendingInventory
} from "../controllers/purchaseController.js";
import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";

const router = express.Router();

// ===== CHANGED: use S3 upload instead of local diskStorage =====
const purchaseUpload = upload.fields([
  { name: "document", maxCount: 1 },
  { name: "itemPhotos", maxCount: 10 }
]);

router.post("/create", authMiddleware, requireStore, purchaseUpload, createPurchase);

router.get("/get", authMiddleware, requireStore, getPurchases);
router.get(
  "/report",
  authMiddleware,
  requireStore,
  getPurchaseReport
);
router.get(
  "/report/export-excel",
  authMiddleware,
  requireStore,
  exportPurchaseReportExcel
);
router.get("/report/export-pdf", authMiddleware, requireStore, exportPurchaseReportPdf);
router.get("/getById/:id", authMiddleware, requireStore, getPurchaseById);

router.get("/itemsByPurchase/:id", authMiddleware, requireStore, getPurchaseItemsByPurchaseId);

router.get("/pending-inventory", authMiddleware, requireStore, getPurchasesPendingInventory);

router.get("/old-gold/by-phone", authMiddleware, requireStore, getOldGoldPurchasesByPhone);

router.put("/update/:id", authMiddleware, requireStore, purchaseUpload, updatePurchase);

router.delete("/delete/:id", authMiddleware, requireStore, deletePurchase);

router.get("/count", authMiddleware, requireStore, getPurchaseCount);
router.get("/downloadPdf/:id", authMiddleware, requireStore, downloadPurchasePdf);
export default router;
