import express from "express";
import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";
import { getReportCatalogue, getReport } from "../controllers/reportController.js";

const router = express.Router();

// GET /api/reports                → catalogue
// GET /api/reports/:key?format=   → json | xlsx | pdf (store-scoped; tenant enforced by authMiddleware)
router.get("/", authMiddleware, getReportCatalogue);
router.get("/:key", authMiddleware, requireStore, getReport);

export default router;
