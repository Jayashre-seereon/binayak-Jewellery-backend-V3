import express from "express";
import {
  getAccountingSummary,
  getNextNumber,
  getAccounts,
  createAccount,
  getPendingSales,
  getPendingPurchases,
  getPendingSuppliers,
  createReceipt,
  getReceipts,
  createPayment,
  getPayments,
  createJournal,
  getJournals,
  getVoucherById,
  downloadVoucherPdf,
  cancelVoucher,
} from "../controllers/accountingController.js";
import { authMiddleware, requireStore } from "../middleware/authMiddleware.js";

const router = express.Router();

// Every accounting endpoint is store-scoped; an ADMIN must pick a store with ?storeId=.
router.use(authMiddleware, requireStore);

router.get("/summary", getAccountingSummary);
router.get("/next-number", getNextNumber);
router.get("/accounts", getAccounts);
router.post("/accounts", createAccount);
router.get("/pending-sales", getPendingSales);
router.get("/pending-purchases", getPendingPurchases);
router.get("/pending-suppliers", getPendingSuppliers);

router.post("/receipts", createReceipt);
router.get("/receipts", getReceipts);

router.post("/payments", createPayment);
router.get("/payments", getPayments);

router.post("/journals", createJournal);
router.get("/journals", getJournals);

router.get("/vouchers/:id", getVoucherById);
router.get("/vouchers/:id/downloadPdf", downloadVoucherPdf);
router.post("/vouchers/:id/cancel", cancelVoucher);

export default router;
