import express from "express";
import {
  createCategory,
  getCategories,
  getCategoryById,
  updateCategory,
  deleteCategory,
} from "../controllers/categoryController.js";

import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/create", authMiddleware, requireStore, createCategory);
router.get("/get", authMiddleware, requireStore, getCategories);
router.get("/getbyId/:id", authMiddleware, requireStore, getCategoryById);
router.put("/update/:id", authMiddleware, requireStore, updateCategory);
router.delete("/delete/:id", authMiddleware, requireStore, deleteCategory);

export default router;