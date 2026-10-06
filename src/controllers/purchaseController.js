import * as purchaseService from "../services/purchaseService.js";
import * as purchasePdfService from "../services/purchasePdfService.js";
import * as reportExcelService from "../services/reportExcelService.js";
import * as reportPdfService from "../services/reportPdfService.js";
import { safeMessage } from "../middleware/errorHandler.js";
import { AppError } from "../utils/validate.js";

const fail = (res, err, fallbackStatus = 400) =>
  res.status(err?.status || fallbackStatus).json({ success: false, message: safeMessage(err, "Unable to complete purchase action. Please try again.") });

const parsePayload = (req) => {
  if (typeof req.body?.data === "string") {
    try {
      return JSON.parse(req.body.data);
    } catch {
      throw new AppError("Invalid purchase data.");
    }
  }
  return req.body || {};
};

/**
 * Attaches uploaded files to the payload (PUR-15). A file goes to the row named by that row's
 * `photoIndex` (index into itemPhotos), or by `itemPhotoRows[k]` for the k-th file; without
 * either, files map to rows in order (legacy clients).
 */
const attachUploads = (req, data) => {
  if (req.files?.document?.[0]) {
    data.document = req.files.document[0].location;
  }
  const photos = req.files?.itemPhotos || [];
  if (!photos.length || !Array.isArray(data.items)) return data;
  const byIndex = data.items.some((it) => it && it.photoIndex !== undefined && it.photoIndex !== null && it.photoIndex !== "");
  if (byIndex) {
    data.items.forEach((it) => {
      const k = Number(it?.photoIndex);
      if (Number.isInteger(k) && photos[k]) it.itemPhoto = photos[k].location;
    });
  } else if (Array.isArray(data.itemPhotoRows)) {
    photos.forEach((file, k) => {
      const row = Number(data.itemPhotoRows[k]);
      if (Number.isInteger(row) && data.items[row]) data.items[row].itemPhoto = file.location;
    });
  } else {
    photos.forEach((file, i) => {
      if (data.items[i]) data.items[i].itemPhoto = file.location;
    });
  }
  return data;
};
export const createPurchase = async (req, res) => {
  try {
    const storeId = Number(req.query.storeId);
    const data = attachUploads(req, parsePayload(req));

    const purchase = await purchaseService.createPurchase(data, storeId);

    res.status(201).json({
      success: true,
      message: "Purchase created successfully",
      purchase: { ...purchase, pdfUrl: `/api/purchases/downloadPdf/${purchase.id}?storeId=${storeId}` }
    });
  } catch (err) {
    fail(res, err);
  }
};

export const updatePurchase = async (req, res) => {
  try {
    const data = attachUploads(req, parsePayload(req));

    const purchase = await purchaseService.updatePurchase(
      Number(req.params.id),
      data,
      Number(req.query.storeId)
    );

    res.json({
      success: true,
      message: "Purchase updated successfully",
      purchase
    });
  } catch (err) {
    fail(res, err);
  }
};

export const getPurchases = async (req, res) => {
  try {
    const storeId = Number(req.query.storeId);

    const paginated = req.query.page !== undefined || req.query.limit !== undefined || req.query.search !== undefined;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 10));
    const result = await purchaseService.getPurchases(storeId, {
      paginated, page, skip: (page - 1) * limit, take: limit,
      search: req.query.search || "", purchaseType: String(req.query.purchaseType || "").trim().toUpperCase() === "ALL" ? "" : String(req.query.purchaseType || "").trim().toUpperCase(),
    });
    const purchases = paginated ? result.purchases : result;

    res.json({
      success: true,
      purchases: purchases.map((purchase) => ({
        ...purchase,
        pdfUrl: `/api/purchases/downloadPdf/${purchase.id}?storeId=${storeId}`,
      })),
      ...(paginated ? { pagination: {
        page, limit, total: result.total,
        totalPages: Math.ceil(result.total / limit),
        hasNextPage: page < Math.ceil(result.total / limit),
        hasPreviousPage: page > 1,
      } } : {}),
    });
  } catch (err) {
    fail(res, err);
  }
};

export const getPurchaseById = async (req, res) => {
  try {
    const purchase = await purchaseService.getPurchaseById(
      Number(req.params.id),
      Number(req.query.storeId)
    );

    res.json({
      success: true,
      purchase: { ...purchase, pdfUrl: `/api/purchases/downloadPdf/${purchase.id}?storeId=${Number(req.query.storeId)}` }
    });
  } catch (err) {
    fail(res, err);
  }
};

export const getPurchaseItemsByPurchaseId = async (req, res) => {
  try {
    const purchaseItems = await purchaseService.getPurchaseItemsByPurchaseId(
      Number(req.params.id),
      Number(req.query.storeId),
      { withoutInventory: ["1", "true"].includes(String(req.query.withoutInventory || "").toLowerCase()) }
    );

    res.json({
      success: true,
      purchaseItems
    });
  } catch (err) {
    fail(res, err);
  }
};

/** GET /api/purchases/pending-inventory?purchaseType=&search= — purchases with lines not yet tagged (INV-16). */
export const getPurchasesPendingInventory = async (req, res) => {
  try {
    const data = await purchaseService.getPurchasesPendingInventory(Number(req.query.storeId), {
      purchaseType: req.query.purchaseType ? String(req.query.purchaseType).toUpperCase() : undefined,
      search: req.query.search,
    });
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
};

export const getOldGoldPurchasesByPhone = async (req, res) => {
  try {
    const storeId = Number(req.query.storeId);
    const phone = String(req.query.phone || "").trim();

    const purchases =
      await purchaseService.getOldGoldPurchasesByPhoneService(
        storeId,
        phone
      );

    res.json({
      success: true,
      purchases,
    });
  } catch (err) {
    fail(res, err);
  }
};



export const deletePurchase = async (req, res) => {
  try {
    await purchaseService.deletePurchase(
      Number(req.params.id),
      Number(req.query.storeId)
    );

    res.json({
      success: true,
      message: "Purchase deleted successfully"
    });
  } catch (err) {
    fail(res, err);
  }
};

export const getPurchaseCount = async (req, res) => {
  try {
    const storeId = Number(req.query.storeId);

    const count = await purchaseService.getPurchaseCount(
      storeId
    );

    res.json({
      success: true,
      count
    });
  } catch (err) {
    fail(res, err);
  }
};

export const downloadPurchasePdf = async (req, res) => {
  try {
    const purchaseId = Number(req.params.id);
    const storeId = Number(req.query?.storeId);

    if (!purchaseId) {
      return res.status(400).json({
        success: false,
        message: "Please select a purchase record."
      });
    }

    await purchasePdfService.generatePurchasePdf(
      purchaseId,
      storeId,
      res
    );
  } catch (err) {
    console.error("Purchase PDF Error:", err);

    if (!res.headersSent) {
      res.status(err?.status || 400).json({
        success: false,
        message: safeMessage(err, "Unable to download the purchase PDF.")
      });
    }
  }
};
export const getPurchaseReport = async (
  req,
  res
) => {
  try {
    const storeId = Number(
      req.query.storeId
    );

    const report =
      await purchaseService.getPurchaseReportService({
        storeId,
        period:
          req.query.period ||
          "THIS_MONTH",
        fromDate: req.query.fromDate,
        toDate: req.query.toDate,
        purchaseType:
          req.query.purchaseType || "ALL",
      });

    return res.json({
      success: true,
      ...report,
      pdfUrl: `/api/purchases/report/export-pdf?${new URLSearchParams({
        storeId: String(storeId),
        period: String(req.query.period || "THIS_MONTH"),
        purchaseType: String(req.query.purchaseType || "ALL"),
        ...(req.query.fromDate ? { fromDate: String(req.query.fromDate) } : {}),
        ...(req.query.toDate ? { toDate: String(req.query.toDate) } : {}),
      })}`,
    });
  } catch (error) {
    return res.status(error?.status || 400).json({
      success: false,
      message: safeMessage(error, "Unable to load purchase report."),
    });
  }
};

export const exportPurchaseReportExcel = async (
  req,
  res
) => {
  try {
    const storeId = Number(
      req.query.storeId
    );

    const report =
      await purchaseService.getPurchaseReportService({
        storeId,
        period:
          req.query.period ||
          "THIS_MONTH",
        fromDate: req.query.fromDate,
        toDate: req.query.toDate,
        purchaseType:
          req.query.purchaseType || "ALL",
      });

    await reportExcelService.generatePurchaseReportExcel(report, res);
  } catch (error) {
    console.error("Export purchase report excel error:", error);
    if (!res.headersSent) {
      return res.status(error?.status || 400).json({
        success: false,
        message: safeMessage(error, "Unable to export purchase report to Excel."),
      });
    }
  }
};

export const exportPurchaseReportPdf = async (req, res) => {
  try {
    const report = await purchaseService.getPurchaseReportService({
      storeId: Number(req.query.storeId), period: req.query.period || "THIS_MONTH",
      fromDate: req.query.fromDate, toDate: req.query.toDate, purchaseType: req.query.purchaseType || "ALL",
    });
    await reportPdfService.generatePurchaseReportPdf(report, res);
  } catch (error) {
    console.error("Export purchase report PDF error:", error);
    if (!res.headersSent) return res.status(error?.status || 400).json({ success: false, message: safeMessage(error, "Unable to export purchase report to PDF.") });
  }
};
