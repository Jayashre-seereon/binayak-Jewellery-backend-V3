import express from "express";
import * as ctrl from "../controllers/PartyOpeningBalanceController.js";
import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";
const router = express.Router();

router.post("/create", authMiddleware, requireStore, ctrl.createPartyOpeningBalance);
router.get("/get", authMiddleware, requireStore, ctrl.getPartyOpeningBalances);
router.get("/getById/:id", authMiddleware, requireStore, ctrl.getPartyOpeningBalanceById);
router.put("/update/:id", authMiddleware, requireStore, ctrl.updatePartyOpeningBalance);
router.delete("/delete/:id", authMiddleware, requireStore, ctrl.deletePartyOpeningBalance);

export default router;