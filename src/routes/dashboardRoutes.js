import express from "express";
import { getDashboardSummaryController } from "../controllers/dashboardController.js";
import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";

const router = express.Router();

// Store is resolved from the token (STORE) or ?storeId= (ADMIN); never defaulted.
router.get("/summary", authMiddleware, requireStore, getDashboardSummaryController);

export default router;
