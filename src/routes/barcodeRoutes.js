import express from "express";
import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";
import { getConfig, updateConfig, scan, image } from "../controllers/barcodeController.js";

// Mounted at /api/barcode. Product-barcode routes live in productRoutes.js (/api/products/:id/barcode…).
const router = express.Router();

router.use(authMiddleware, requireStore);

router.get("/config", getConfig);
router.put("/config", updateConfig);
router.get("/scan", scan); // ?code=… for values that contain "/"
router.get("/scan/:code", scan);
router.get("/image", image);
router.get("/image/:code", image);

export default router;
