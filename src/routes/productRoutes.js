import express from "express";
import {
  createProduct,
  getProducts,
  getProductsByMetalId,
  getProductById,
  updateProduct,
  deleteProduct,
} from "../controllers/productController.js";
import { upload } from "../middleware/uploadS3.js";
import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(authMiddleware, requireStore);

router.post("/create", upload.single("image"), createProduct);
router.get("/get/", getProducts);
router.get("/getByMetal/:metalId", getProductsByMetalId);
router.get("/getById/:id", getProductById);
router.put("/update/:id", upload.single("image"), updateProduct);
router.delete("/delete/:id", deleteProduct);


export default router;
