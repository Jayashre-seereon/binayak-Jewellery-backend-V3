// Sales / Purchase Report workbooks (called by /api/sales|purchases/report/export-excel).
// Same engine, columns and styling as the PDF and the Reports hub.
import { renderReportExcel, reportFileName } from "./reports/index.js";
import { buildSalesReport, buildPurchaseReport } from "./reports/legacyAdapters.js";
import { sendFile } from "../controllers/reportController.js";

export const generateSalesReportExcel = async (reportData, res) => {
  const report = await buildSalesReport(reportData, res);
  return sendFile(res, await renderReportExcel(report), reportFileName(report), "xlsx");
};

export const generatePurchaseReportExcel = async (reportData, res) => {
  const report = await buildPurchaseReport(reportData, res);
  return sendFile(res, await renderReportExcel(report), reportFileName(report), "xlsx");
};
