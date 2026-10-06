import express from "express";
import {
  createPartyType,
  getPartyTypes,
  getPartyTypeById,
  updatePartyType,
  deletePartyType
} from "../controllers/partytypeController.js";

import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/create", authMiddleware, requireStore, createPartyType);
router.get("/get", authMiddleware, requireStore, getPartyTypes);
router.get("/getbyId/:id", authMiddleware, requireStore, getPartyTypeById);
router.put("/update/:id", authMiddleware, requireStore, updatePartyType);
router.delete("/delete/:id", authMiddleware, requireStore, deletePartyType);

export default router;