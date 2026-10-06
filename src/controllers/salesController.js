import * as salesService from "../services/salesService.js";
import * as salesPdfService from "../services/salesPdfService.js";
import * as reportExcelService from "../services/reportExcelService.js";
import * as reportPdfService from "../services/reportPdfService.js";
import { safeMessage } from "../middleware/errorHandler.js";

// authMiddleware pins STORE logins to their own store; ADMIN must pick one with ?storeId=.
const storeIdOf = (req) => {
  const sid = Number(req.storeId || req.query.storeId);
  return Number.isInteger(sid) && sid > 0 ? sid : null;
};

const fail = (res, error, fallback, logLabel) => {
  const status = error?.status || 400;
  if (status >= 500 || !error?.status) console.error(logLabel || fallback, error);
  return res.status(status).json({ success: false, message: safeMessage(error, fallback) });
};

const noStore = (res, message = "Please select a store.") => res.status(400).json({ success: false, message });

const pdfUrlOf = (id, storeId) => `/api/sales/downloadPdf/${id}?storeId=${storeId}`;

export const createSale = async (req, res) => {
  try {
    const storeId = storeIdOf(req);
    if (!storeId) return noStore(res, "Please select a store before creating a sale.");

    const sale = await salesService.createSaleService(req.body, storeId, req.user);

    return res.status(201).json({
      success: true,
      message: "Sale created successfully",
      sale: { ...sale, pdfUrl: pdfUrlOf(sale.id, storeId) },
      invoiceNo: sale.invoiceNo,
      pdfUrl: pdfUrlOf(sale.id, storeId),
    });
  } catch (error) {
    return fail(res, error, "Unable to create sale. Please try again.", "Create sale error:");
  }
};

export const cancelSale = async (req, res) => {
  try {
    const storeId = storeIdOf(req);
    if (!storeId) return noStore(res);

    const sale = await salesService.cancelSaleService(req.params.id, storeId, { reason: req.body?.reason }, req.user);
    return res.json({
      success: true,
      message: `Invoice ${sale.invoiceNo} cancelled`,
      data: { ...sale, pdfUrl: pdfUrlOf(sale.id, storeId) },
    });
  } catch (error) {
    return fail(res, error, "Unable to cancel the sale.", "Cancel sale error:");
  }
};

export const getSales = async (req, res) => {
  try {
    const storeId = storeIdOf(req);
    if (!storeId) return noStore(res, "Please select a store to view sales.");

    const paginated = req.query.page !== undefined || req.query.limit !== undefined || req.query.search !== undefined;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 10));
    const status = ["COMPLETED", "CANCELLED"].includes(String(req.query.status || "").toUpperCase())
      ? String(req.query.status).toUpperCase()
      : undefined;
    const result = await salesService.getSalesService(storeId, {
      paginated,
      skip: paginated ? (page - 1) * limit : undefined,
      take: paginated ? limit : undefined,
      search: req.query.search || "",
      status,
    });
    const sales = paginated ? result.sales : result;

    return res.json({
      success: true,
      count: sales.length,
      sales: sales.map((item) => ({ ...item, pdfUrl: pdfUrlOf(item.id, storeId) })),
      ...(paginated
        ? {
            pagination: {
              page,
              limit,
              total: result.total,
              totalPages: Math.ceil(result.total / limit),
              hasNextPage: page < Math.ceil(result.total / limit),
              hasPreviousPage: page > 1,
            },
          }
        : {}),
    });
  } catch (error) {
    return fail(res, error, "Unable to load sales at the moment.");
  }
};

export const getSaleById = async (req, res) => {
  try {
    const storeId = storeIdOf(req);
    if (!storeId) return noStore(res);

    const sale = await salesService.getSaleByIdService(req.params.id, storeId);
    return res.json({ success: true, sale: { ...sale, pdfUrl: pdfUrlOf(sale.id, storeId) } });
  } catch (error) {
    return fail(res, error, "Sale record not found.");
  }
};

export const getSaleCount = async (req, res) => {
  try {
    const storeId = storeIdOf(req);
    if (!storeId) return noStore(res);

    const count = await salesService.getSaleCountService(storeId);
    return res.json({ success: true, count });
  } catch (error) {
    return fail(res, error, "Unable to load sale summary.");
  }
};

export const downloadSalePdf = async (req, res) => {
  try {
    const saleId = Number(req.params.id);
    const storeId = storeIdOf(req);

    if (!Number.isInteger(saleId) || saleId <= 0) {
      return res.status(400).json({ success: false, message: "Please choose a sale invoice to download." });
    }
    if (!storeId) return noStore(res, "Please select a store before downloading the invoice.");

    await salesPdfService.generateSalePdf(saleId, storeId, res);
  } catch (error) {
    console.error("Download sale PDF error:", error);
    if (!res.headersSent) {
      return res.status(error?.status || 400).json({ success: false, message: safeMessage(error, "Unable to download the invoice right now.") });
    }
  }
};

const reportParams = (req, storeId) => ({
  storeId,
  period: req.query.period || "THIS_MONTH",
  fromDate: req.query.fromDate,
  toDate: req.query.toDate,
  status: req.query.status,
});

const reportQueryString = (req, storeId) => {
  const qs = new URLSearchParams({ storeId: String(storeId), period: String(req.query.period || "THIS_MONTH") });
  for (const k of ["fromDate", "toDate", "status"]) if (req.query[k]) qs.set(k, String(req.query[k]));
  return qs.toString();
};

export const getSalesReport = async (req, res) => {
  try {
    const storeId = storeIdOf(req);
    if (!storeId) return noStore(res, "Please select a store to view the sales report.");

    const report = await salesService.getSalesReportService(reportParams(req, storeId));
    return res.json({
      success: true,
      ...report,
      pdfUrl: `/api/sales/report/export-pdf?${reportQueryString(req, storeId)}`,
    });
  } catch (error) {
    return fail(res, error, "Unable to load sales report.");
  }
};

export const exportSalesReportExcel = async (req, res) => {
  try {
    const storeId = storeIdOf(req);
    if (!storeId) return noStore(res, "Please select a store to export the sales report.");

    const report = await salesService.getSalesReportService(reportParams(req, storeId));
    await reportExcelService.generateSalesReportExcel(report, res);
  } catch (error) {
    console.error("Export sales report excel error:", error);
    if (!res.headersSent) {
      return res.status(error?.status || 400).json({ success: false, message: safeMessage(error, "Unable to export sales report to Excel.") });
    }
  }
};

export const exportSalesReportPdf = async (req, res) => {
  try {
    const storeId = storeIdOf(req);
    if (!storeId) return noStore(res, "Please select a store to export the sales report.");

    const report = await salesService.getSalesReportService(reportParams(req, storeId));
    await reportPdfService.generateSalesReportPdf(report, res);
  } catch (error) {
    console.error("Export sales report PDF error:", error);
    if (!res.headersSent) {
      return res.status(error?.status || 400).json({ success: false, message: safeMessage(error, "Unable to export sales report to PDF.") });
    }
  }
};
