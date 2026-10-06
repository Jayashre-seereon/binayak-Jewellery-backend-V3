import express from "express";
import * as ctrl from "../controllers/purityController.js";
import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/create", authMiddleware, requireStore, ctrl.createPurity);
router.get("/get", authMiddleware, requireStore, ctrl.getPurities);
router.get("/getById/:id", authMiddleware, requireStore, ctrl.getPurityById);
router.get("/getByMetal/:metalId",authMiddleware, requireStore, ctrl.getPuritiesByMetalId);
router.put("/update/:id", authMiddleware, requireStore, ctrl.updatePurity);
router.delete("/delete/:id", authMiddleware, requireStore, ctrl.deletePurity);

export default router;