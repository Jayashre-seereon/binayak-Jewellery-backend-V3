import { runReport, listReports, renderReportPdf, renderReportExcel, reportFileName } from "../services/reports/index.js";
import { safeMessage } from "../middleware/errorHandler.js";

const MIME = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Sends a generated file as a download (filename readable by the browser through CORS). */
export const sendFile = (res, buffer, filename, format) => {
  res.setHeader("Content-Type", MIME[format]);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.${format}"; filename*=UTF-8''${encodeURIComponent(`${filename}.${format}`)}`);
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  res.setHeader("Content-Length", buffer.length);
  res.setHeader("Cache-Control", "no-store");
  return res.end(buffer);
};

export const getReportCatalogue = (req, res) => res.json({ success: true, data: listReports() });

export const getReport = async (req, res) => {
  try {
    const format = String(req.query.format || "json").toLowerCase();
    if (!["json", "xlsx", "pdf", "excel"].includes(format)) {
      return res.status(400).json({ success: false, message: "format must be json, xlsx or pdf." });
    }
    const report = await runReport(req.params.key, req.storeId ?? Number(req.query.storeId), req.query);
    if (format === "pdf") return sendFile(res, await renderReportPdf(report), reportFileName(report), "pdf");
    if (format === "xlsx" || format === "excel") return sendFile(res, await renderReportExcel(report), reportFileName(report), "xlsx");
    const { orientation, ...data } = report;
    void orientation;
    return res.json({ success: true, data });
  } catch (err) {
    if (!err.status) console.error(`Report ${req.params.key} error:`, err);
    if (res.headersSent) return res.end();
    return res.status(err.status || 500).json({ success: false, message: err.status ? safeMessage(err) : "Unable to generate the report right now." });
  }
};
