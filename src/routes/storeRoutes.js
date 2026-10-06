import express from "express";
import {
  createStoreController, getAllStoresController, getStoreByIdController, updateStoreController,
  deleteStoreController, resetStorePasswordController, getStoreOptionsController,
} from "../controllers/storeController.js";
import { authMiddleware, requireRole } from "../middleware/authMiddleware.js";
import { refreshStoreToken } from "../controllers/userController.js";
import { refreshLimiter } from "./userRoutes.js";

const router = express.Router();
const admin = [authMiddleware, requireRole("ADMIN")];

router.post("/refresh-token", refreshLimiter, refreshStoreToken);
// any logged-in user: lightweight list for pickers (e.g. "To Store" in transfers)
router.get("/options", authMiddleware, getStoreOptionsController); // admins get GSTIN/CIN too; stores get id/name/location
router.post("/create", ...admin, createStoreController);
router.get("/get", ...admin, getAllStoresController);
router.get("/getById/:id", ...admin, getStoreByIdController);
router.put("/update/:id", ...admin, updateStoreController);
router.put("/:id/password", ...admin, resetStorePasswordController);
router.delete("/delete/:id", ...admin, deleteStoreController);

export default router;
