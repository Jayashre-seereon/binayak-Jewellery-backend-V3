import express from "express";

import {
  createStone,
  getStones,
  getStonesByProductIdAndItemId,
  getStoneById,
  updateStone,
  deleteStone,
} from "../controllers/stoneController.js";
import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";
const router = express.Router();

router.post("/create", authMiddleware, requireStore, createStone);
router.get("/get", authMiddleware, requireStore, getStones);
router.get("/getByProductItem/:productId/:itemId", authMiddleware, requireStore, getStonesByProductIdAndItemId);
router.get("/getById/:id", authMiddleware, requireStore, getStoneById);
router.put("/update/:id", authMiddleware, requireStore, updateStone);
router.delete("/delete/:id", authMiddleware, requireStore, deleteStone);

export default router;
