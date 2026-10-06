import express from "express";
import {
  createBrand,
  getBrands,
  updateBrand,
  deleteBrand,
    getBrandById
} from "../controllers/brandController.js";

import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/create", authMiddleware, requireStore, createBrand);
router.get("/get", authMiddleware, requireStore, getBrands);
router.get("/getbyId/:id", authMiddleware, requireStore, getBrandById);
router.put("/update/:id", authMiddleware, requireStore, updateBrand);
router.delete("/delete/:id", authMiddleware, requireStore, deleteBrand);

export default router;