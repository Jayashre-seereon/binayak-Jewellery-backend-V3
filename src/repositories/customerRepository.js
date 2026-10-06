import prisma from "../config/db.js";
import { cleanPhone } from "../utils/validate.js";

// Customers are per store (@@unique([storeId, phone])). Every lookup is filtered by storeId,
// and the owning Store row is never included (it would carry credential columns).

export const findCustomerByPhoneRepo = async (phone, storeId, tx = prisma) => {
  const p = cleanPhone(phone);
  const sid = Number(storeId);
  if (!p || !Number.isInteger(sid) || sid <= 0) return null;

  return tx.customer.findFirst({
    where: { storeId: sid, phone: p },
  });
};

export const findCustomerByIdRepo = async (id, storeId, tx = prisma) => {
  return tx.customer.findFirst({
    where: { id: Number(id), storeId: Number(storeId) },
  });
};

/**
 * Race-safe create: two concurrent first-time sales for the same phone resolve to one row
 * (upsert on the per-store unique key instead of create + catch, which would abort the tx).
 */
export const createCustomerRepo = async (data, tx = prisma) => {
  const phone = cleanPhone(data.phone);
  const storeId = Number(data.storeId);
  return tx.customer.upsert({
    where: { storeId_phone: { storeId, phone } },
    update: {},
    create: {
      name: data.name?.trim() || "Valued Customer",
      phone,
      address: data.address?.trim() || null,
      city: data.city?.trim() || null,
      state: data.state?.trim()?.toUpperCase() || "ODISHA",
      pan: data.pan?.trim()?.toUpperCase() || null,
      gst: data.gst?.trim()?.toUpperCase() || null,
      idType: data.idType || null,
      idNumber: data.idNumber || null,
      customerCode: data.customerCode || null,
      storeId,
    },
  });
};

export const updateCustomerRepo = async (id, data, tx = prisma) => {
  const updatePayload = {};
  if (data.name) updatePayload.name = data.name.trim();
  if (data.address !== undefined) updatePayload.address = data.address?.trim() || null;
  if (data.city !== undefined) updatePayload.city = data.city?.trim() || null;
  if (data.state !== undefined) updatePayload.state = data.state?.trim() || "ODISHA";
  if (data.pan !== undefined) updatePayload.pan = data.pan?.trim()?.toUpperCase() || null;
  if (data.gst !== undefined) updatePayload.gst = data.gst?.trim()?.toUpperCase() || null;
  if (data.idType !== undefined) updatePayload.idType = data.idType || null;
  if (data.idNumber !== undefined) updatePayload.idNumber = data.idNumber || null;

  return tx.customer.update({
    where: { id: Number(id) },
    data: updatePayload,
  });
};

export const getCustomerAdjustmentLogsRepo = async (customerId, storeId, tx = prisma) => {
  return tx.customerAdjustmentLog.findMany({
    where: {
      customerId: Number(customerId),
      storeId: Number(storeId),
    },
    orderBy: {
      adjustmentDate: "desc",
    },
    include: {
      sale: {
        select: {
          id: true,
          invoiceNo: true,
          saleDate: true,
          status: true,
          netPayable: true,
          paidAmount: true,
        },
      },
    },
  });
};

export const createCustomerAdjustmentLogRepo = async (data, tx = prisma) => {
  return tx.customerAdjustmentLog.create({
    data: {
      customerId: Number(data.customerId),
      saleId: Number(data.saleId),
      storeId: Number(data.storeId),
      adjustmentType: data.adjustmentType, // "ADVANCE" | "OLD_JEWELLERY"
      referenceId: Number(data.referenceId),
      referenceDocNo: data.referenceDocNo || null,
      saleInvoiceNo: data.saleInvoiceNo,
      totalOriginal: Number(data.totalOriginal || 0),
      previousBalance: Number(data.previousBalance || 0),
      adjustedAmount: Number(data.adjustedAmount || 0),
      remainingBalance: Number(data.remainingBalance || 0),
      cashierName: data.cashierName || null,
      adjustmentDate: data.adjustmentDate ? new Date(data.adjustmentDate) : new Date(),
      notes: data.notes || null,
    },
  });
};

export const listCustomersRepo = async (storeId, { search = "", skip = 0, take = 50 } = {}) => {
  const where = {
    storeId: Number(storeId),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { phone: { contains: search } },
            { customerCode: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [customers, total] = await prisma.$transaction([
    prisma.customer.findMany({ where, orderBy: { id: "desc" }, skip, take }),
    prisma.customer.count({ where }),
  ]);
  return { customers, total };
};
