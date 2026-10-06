// Sales / Purchase Report PDFs (called by /api/sales|purchases/report/export-pdf).
// Rendered by the shared report engine so they match every other report.
import { renderReportPdf, reportFileName } from "./reports/index.js";
import { buildSalesReport, buildPurchaseReport } from "./reports/legacyAdapters.js";
import { sendFile } from "../controllers/reportController.js";

export const generateSalesReportPdf = async (reportData, res) => {
  const report = await buildSalesReport(reportData, res);
  return sendFile(res, await renderReportPdf(report), reportFileName(report), "pdf");
};

export const generatePurchaseReportPdf = async (reportData, res) => {
  const report = await buildPurchaseReport(reportData, res);
  return sendFile(res, await renderReportPdf(report), reportFileName(report), "pdf");
};
