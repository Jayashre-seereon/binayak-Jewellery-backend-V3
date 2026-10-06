import * as accountingService from "../services/accountingService.js";
import { generateVoucherPdf } from "../services/voucherPdfService.js";
import { safeMessage } from "../middleware/errorHandler.js";

// authMiddleware has already bound the store (STORE logins are forced to their own id).
const getStoreId = (req) => Number(req.storeId || req.query.storeId) || 0;

const fail = (res, error, label) => {
  const status = Number(error?.status || error?.statusCode) || 400;
  if (status >= 500 || !error?.expose) console.error(`${label} error:`, error);
  return res.status(status >= 500 ? 500 : status).json({ success: false, message: safeMessage(error) });
};


const noStore = (res) => res.status(400).json({ success: false, message: "Please select a store." });

const pdfUrl = (voucher, storeId) => `/api/accounting/vouchers/${voucher.id}/downloadPdf?storeId=${storeId}`;

export const getAccountingSummary = async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return noStore(res);
    const summary = await accountingService.getAccountingSummaryService(storeId);
    return res.status(200).json({ success: true, data: summary });
  } catch (error) {
    return fail(res, error, "getAccountingSummary");
  }
};

export const getNextNumber = async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return noStore(res);
    const nextNumber = await accountingService.getNextVoucherNumberPreviewService(req.query.type || "RECEIPT", storeId);
    return res.status(200).json({ success: true, nextNumber });
  } catch (error) {
    return fail(res, error, "getNextNumber");
  }
};

export const getAccounts = async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return noStore(res);
    const accounts = await accountingService.getAccountsService(storeId);
    return res.status(200).json({ success: true, data: accounts });
  } catch (error) {
    return fail(res, error, "getAccounts");
  }
};

export const createAccount = async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return noStore(res);
    const account = await accountingService.createAccountService(req.body, storeId);
    return res.status(201).json({ success: true, message: `Account ${account.accountName} created`, data: account });
  } catch (error) {
    return fail(res, error, "createAccount");
  }
};

export const getPendingSales = async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return noStore(res);
    const sales = await accountingService.getCustomerPendingSalesService(req.query.customerId, req.query.phone, storeId);
    return res.status(200).json({ success: true, data: sales });
  } catch (error) {
    return fail(res, error, "getPendingSales");
  }
};

export const getPendingPurchases = async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return noStore(res);
    const { partyId, phone } = req.query;
    const result = await accountingService.getSupplierPendingPurchasesService({ partyId, phone }, storeId);
    return res.status(200).json({
      success: true,
      supplier: result.supplier,
      totalOutstandingDue: result.totalOutstandingDue,
      data: result.data,
    });
  } catch (error) {
    return fail(res, error, "getPendingPurchases");
  }
};

export const getPendingSuppliers = async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return noStore(res);
    const suppliers = await accountingService.getPendingSuppliersService(storeId);
    return res.status(200).json({ success: true, data: suppliers });
  } catch (error) {
    return fail(res, error, "getPendingSuppliers");
  }
};

const createHandler = (label, serviceFn, title) => async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return noStore(res);
    const voucher = await serviceFn(req.body || {}, storeId, req.user);
    return res.status(201).json({
      success: true,
      message: `${title} ${voucher.voucherNo} created successfully`,
      data: { ...voucher, pdfUrl: pdfUrl(voucher, storeId) },
    });
  } catch (error) {
    return fail(res, error, label);
  }
};

const listHandler = (label, type) => async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return noStore(res);
    const result = await accountingService.getVouchersService(type, storeId, req.query);
    return res.status(200).json({
      success: true,
      ...result,
      vouchers: result.vouchers.map((voucher) => ({ ...voucher, pdfUrl: pdfUrl(voucher, storeId) })),
    });
  } catch (error) {
    return fail(res, error, label);
  }
};

export const createReceipt = createHandler("createReceipt", accountingService.createReceiptVoucherService, "Receipt Voucher");
export const createPayment = createHandler("createPayment", accountingService.createPaymentVoucherService, "Payment Voucher");
export const createJournal = createHandler("createJournal", accountingService.createJournalEntryService, "Journal Entry");

export const getReceipts = listHandler("getReceipts", "RECEIPT");
export const getPayments = listHandler("getPayments", "PAYMENT");
export const getJournals = listHandler("getJournals", "JOURNAL");

export const getVoucherById = async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return noStore(res);
    const voucher = await accountingService.getVoucherByIdService(req.params.id, storeId);
    return res.status(200).json({ success: true, data: { ...voucher, pdfUrl: pdfUrl(voucher, storeId) } });
  } catch (error) {
    return fail(res, error, "getVoucherById");
  }
};

export const downloadVoucherPdf = async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return noStore(res);
    const voucher = await accountingService.getVoucherByIdService(req.params.id, storeId);
    await generateVoucherPdf(voucher, res);
  } catch (error) {
    if (!res.headersSent) return fail(res, error, "downloadVoucherPdf");
    console.error("downloadVoucherPdf error:", error);
  }
};

export const cancelVoucher = async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return noStore(res);
    const updated = await accountingService.cancelVoucherService(req.params.id, storeId, req.body?.reason, req.user);
    return res.status(200).json({
      success: true,
      message: `Voucher ${updated.voucherNo} has been cancelled and reversed`,
      data: updated,
    });
  } catch (error) {
    return fail(res, error, "cancelVoucher");
  }
};
