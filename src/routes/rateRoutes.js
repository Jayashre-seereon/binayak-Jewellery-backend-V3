import express from "express";
import * as ctrl from "../controllers/rateController.js";
import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/create", authMiddleware, requireStore, ctrl.createRate);
router.get("/get", authMiddleware, requireStore, ctrl.getRates);
router.get("/getById/:id", authMiddleware, requireStore, ctrl.getRateById);
router.put("/update/:id", authMiddleware, requireStore, ctrl.updateRate);
router.delete("/delete/:id", authMiddleware, requireStore, ctrl.deleteRate);

export default router;