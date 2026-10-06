import express from "express";
import {
  createEmployee,
  getEmployees,
  getEmployeeById,
  updateEmployee,
  deleteEmployee,
} from "../controllers/employeeController.js";
import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";
const router = express.Router();

router.post("/create", authMiddleware, requireStore, createEmployee);
router.get("/get", authMiddleware, requireStore, getEmployees);
router.get("/getById/:id", authMiddleware, requireStore, getEmployeeById);
router.put("/update/:id", authMiddleware, requireStore, updateEmployee);
router.delete("/delete/:id", authMiddleware, requireStore, deleteEmployee);

export default router;