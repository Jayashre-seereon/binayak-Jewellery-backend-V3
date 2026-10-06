import express from "express";

import {
  createSale,
  cancelSale,
  getSales,
  getSaleById,
  getSaleCount,
  downloadSalePdf,
  getSalesReport,
  exportSalesReportExcel,
  exportSalesReportPdf,
} from "../controllers/salesController.js";

import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/create", authMiddleware, createSale);
router.post("/:id/cancel", authMiddleware, cancelSale);

router.get("/get", authMiddleware, getSales);
router.get("/report", authMiddleware, getSalesReport);
router.get("/report/export-excel", authMiddleware, exportSalesReportExcel);
router.get("/report/export-pdf", authMiddleware, exportSalesReportPdf);
router.get("/getById/:id", authMiddleware, getSaleById);
router.get("/count", authMiddleware, getSaleCount);
router.get("/downloadPdf/:id", authMiddleware, downloadSalePdf);

export default router;
