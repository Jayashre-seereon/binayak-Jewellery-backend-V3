import prisma from "../config/db.js";
import * as advanceReceiveRepo from "../repositories/advanceReceiveRepository.js";
import { AppError, parseId, cleanString, toDate } from "../utils/validate.js";
import { last10 } from "./sales/balances.js";

// Advances are created only through Accounts -> Receipt Voucher (type ADVANCE), which posts the
// cash/bank and "Customer Advance" ledger lines. These legacy endpoints keep read access and a
// narrow, ledger-neutral edit for advances that are not tied to vouchers or sales.

export const RECEIPT_VOUCHER_ONLY =
  "Advances are recorded through Accounts → Receipt Voucher (type: Advance), which also posts the cash / bank entry. Please use the Receipt Voucher screen.";

const validateStoreId = (storeId) => {
  const id = Number(storeId);
  if (!Number.isInteger(id) || id <= 0) throw new AppError("Please select a store.");
  return id;
};

const parseReceiveDate = (value) => {
  const raw = String(value ?? "").trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return toDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0), { field: "Receive date" });
  return toDate(raw, { field: "Receive date" });
};

const resolveAdvanceStatus = (row) => {
  if (row.status === "CANCELLED") return "CANCELLED";
  const amount = Number(row.amount || 0);
  const adjusted = Number(row.adjustedAmount || 0);
  const balance = Number(row.balanceAmount ?? Math.max(0, amount - adjusted));
  if (balance <= 0.01 || adjusted >= amount - 0.01) return "FULLY_ADJUSTED";
  if (adjusted > 0) return "PARTIALLY_ADJUSTED";
  return "AVAILABLE";
};

const serializeAdvance = (row) => {
  const amount = Number(row.amount || 0);
  const adjustedAmount = Number(row.adjustedAmount || 0);
  const balanceAmount =
    row.status === "CANCELLED" ? 0 : Math.max(0, Math.min(Number(row.balanceAmount ?? amount), amount - adjustedAmount));
  const status = resolveAdvanceStatus({ ...row, amount, adjustedAmount, balanceAmount });
  const { _count, ...rest } = row;
  return {
    ...rest,
    amount,
    adjustedAmount,
    balanceAmount,
    status,
    date: row.receiveDate || row.createdAt,
  };
};

/** Why an advance may not be edited / deleted outside the voucher flow (null = free). */
const lockReason = (adv) => {
  if (adv.status === "CANCELLED") return "This advance has been cancelled and cannot be changed.";
  if ((adv._count?.vouchers || 0) > 0) {
    return "This advance was recorded by a Receipt Voucher. Cancel or correct it from Accounts → Receipt Voucher.";
  }
  if ((adv._count?.saleAdjustments || 0) > 0 || Number(adv.adjustedAmount || 0) > 0.01) {
    return "This advance has already been adjusted against a sale and cannot be changed.";
  }
  if (resolveAdvanceStatus(adv) === "FULLY_ADJUSTED") return "This advance is fully adjusted and cannot be changed.";
  return null;
};

export const createAdvanceReceiveService = async () => {
  throw new AppError(RECEIPT_VOUCHER_ONLY, 400);
};

export const getAdvanceReceivesService = async (storeId) => {
  const rows = await advanceReceiveRepo.getAdvanceReceivesRepo(validateStoreId(storeId));
  return rows.map(serializeAdvance);
};

export const getAdvanceReceivesByContactService = async (storeId, contactNumber) => {
  const parsedStoreId = validateStoreId(storeId);
  const phone = last10(contactNumber);
  if (!phone) throw new AppError("Contact number is required");
  return (await advanceReceiveRepo.getAdvanceReceivesByContactRepo(parsedStoreId, phone)).map(serializeAdvance);
};

export const getAdvanceReceiveByIdService = async (id, storeId) => {
  const advance = await advanceReceiveRepo.getAdvanceReceiveByIdRepo(parseId(id, "advance receive ID"), validateStoreId(storeId));
  if (!advance) throw new AppError("Advance receive not found", 404);
  return serializeAdvance(advance);
};

export const updateAdvanceReceiveService = async (id, data = {}, storeId) => {
  const parsedStoreId = validateStoreId(storeId);
  const parsedId = parseId(id, "advance receive ID");

  return prisma.$transaction(async (tx) => {
    const existing = await advanceReceiveRepo.getAdvanceReceiveByIdRepo(parsedId, parsedStoreId, tx);
    if (!existing) throw new AppError("Advance receive not found", 404);

    const locked = lockReason(existing);
    if (locked) throw new AppError(locked);

    // Amount, owner (phone) and payment mode define the money and who it belongs to; they are
    // only set by the Receipt Voucher that records the cash.
    if (data.amount !== undefined && Number(data.amount) !== Number(existing.amount)) throw new AppError(RECEIPT_VOUCHER_ONLY);
    if (data.contactNumber !== undefined && last10(data.contactNumber) !== last10(existing.contactNumber)) {
      throw new AppError("The customer of an advance cannot be changed.");
    }
    if (data.paymentMode !== undefined && data.paymentMode !== existing.paymentMode) throw new AppError(RECEIPT_VOUCHER_ONLY);

    const updateData = {};
    if (data.customerName !== undefined) {
      const name = cleanString(data.customerName, 150);
      if (!name) throw new AppError("Customer name is required");
      updateData.customerName = name;
    }
    if (data.address !== undefined) updateData.address = cleanString(data.address, 500);
    if (data.specification !== undefined) updateData.specification = cleanString(data.specification, 500);
    if (data.date !== undefined || data.receiveDate !== undefined) updateData.receiveDate = parseReceiveDate(data.date || data.receiveDate);

    if (Object.keys(updateData).length) {
      const res = await advanceReceiveRepo.updateAdvanceReceiveRepo(
        parsedId,
        parsedStoreId,
        updateData,
        tx,
        { status: existing.status, adjustedAmount: existing.adjustedAmount }
      );
      if (res.count === 0) throw new AppError("This advance was changed by someone else. Please refresh and try again.", 409);
    }

    return serializeAdvance(await advanceReceiveRepo.getAdvanceReceiveByIdRepo(parsedId, parsedStoreId, tx));
  });
};

export const deleteAdvanceReceiveService = async (id, storeId) => {
  const parsedStoreId = validateStoreId(storeId);
  const parsedId = parseId(id, "advance receive ID");

  return prisma.$transaction(async (tx) => {
    const existing = await advanceReceiveRepo.getAdvanceReceiveByIdRepo(parsedId, parsedStoreId, tx);
    if (!existing) throw new AppError("Advance receive not found", 404);

    const locked = lockReason(existing);
    if (locked) throw new AppError(locked);

    const res = await advanceReceiveRepo.deleteAdvanceReceiveRepo(parsedId, parsedStoreId, tx, {
      status: existing.status,
      adjustedAmount: existing.adjustedAmount,
    });
    if (res.count === 0) throw new AppError("This advance was changed by someone else. Please refresh and try again.", 409);

    return { message: "Advance receive deleted successfully" };
  });
};
