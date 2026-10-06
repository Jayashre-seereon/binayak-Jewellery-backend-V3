// Report module entry point: registers every definition and exposes run + render helpers.
import { registerReports, runReport, listReports, getDefinition, resolveColumns, computeTotals, sumBy, n } from "./engine.js";
import { renderReportPdf } from "./pdfRenderer.js";
import { renderReportExcel } from "./excelRenderer.js";
import sales from "./definitions/sales.js";
import purchase from "./definitions/purchase.js";
import parties from "./definitions/parties.js";
import stock from "./definitions/stock.js";
import accounts from "./definitions/accounts.js";
import gst from "./definitions/gst.js";

registerReports([...sales, ...purchase, ...parties, ...stock, ...accounts, ...gst]);

/** File name like "Sales-Register_Binayak-Jewellers_2026-10-01_to_2026-10-31". */
export const reportFileName = (report) => {
  const slug = (s) =>
    String(s || "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  const m = report.meta || {};
  const when = m.period === "ALL" ? "All-Dates" : m.from && m.to ? `${m.from}_to_${m.to}` : `As-on-${m.to || ""}`;
  return [slug(report.name), slug(m.store?.storeName), when].filter(Boolean).join("_");
};

export { runReport, listReports, getDefinition, resolveColumns, computeTotals, sumBy, n, renderReportPdf, renderReportExcel };
