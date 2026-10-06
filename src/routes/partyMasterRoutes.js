import express from "express";
import * as ctrl from "../controllers/partyMasterController.js";
import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";
const router = express.Router();

router.post("/create", authMiddleware, requireStore, ctrl.createPartyMaster);
router.get("/get", authMiddleware, requireStore, ctrl.getPartyMasters);
router.get("/getById/:id", authMiddleware, requireStore, ctrl.getPartyMasterById);
router.put("/update/:id", authMiddleware, requireStore, ctrl.updatePartyMaster);
router.delete("/delete/:id", authMiddleware, requireStore, ctrl.deletePartyMaster);

export default router;