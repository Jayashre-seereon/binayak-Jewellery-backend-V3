import express from "express";
import {
  createMetal,
  getMetals,
  getMetalById,
  updateMetal,
  deleteMetal
} from "../controllers/metalController.js";

import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/create", authMiddleware, requireStore, createMetal);
router.get("/get", authMiddleware, requireStore, getMetals);
router.get("/getById/:id", authMiddleware, requireStore, getMetalById);
router.put("/update/:id", authMiddleware, requireStore, updateMetal);
router.delete("/delete/:id", authMiddleware, requireStore, deleteMetal);

export default router;