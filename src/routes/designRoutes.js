import express from "express";
import {
  createDesign,
  getDesigns,
  getDesignById,
  updateDesign,
  deleteDesign
} from "../controllers/designController.js";
import { upload } from "../middleware/uploadS3.js";
import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/create", authMiddleware, requireStore, upload.single("image"),createDesign);
router.get("/get", authMiddleware, requireStore, getDesigns);
router.get("/getbyId/:id", authMiddleware, requireStore, getDesignById);
router.put("/update/:id", authMiddleware, requireStore, upload.single("image"),updateDesign);
router.delete("/delete/:id", authMiddleware, requireStore, deleteDesign);

export default router;