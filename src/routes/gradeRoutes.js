import express from "express";
import * as ctrl from "../controllers/gradeController.js";
import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";
const router = express.Router();

router.post("/create", authMiddleware, requireStore, ctrl.createGrade);
router.get("/get", authMiddleware, requireStore, ctrl.getGrades);
router.get("/getById/:id", authMiddleware, requireStore, ctrl.getGradeById);
router.get("/getByPurity/:purityId", authMiddleware, requireStore, ctrl.getGradesByPurityId);
router.put("/update/:id", authMiddleware, requireStore, ctrl.updateGrade);
router.delete("/delete/:id", authMiddleware, requireStore, ctrl.deleteGrade);

export default router;