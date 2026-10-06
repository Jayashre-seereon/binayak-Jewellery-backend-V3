import prisma from "../config/db.js";
import { publicStoreSelect } from "../utils/publicSelect.js";

// Full detail (invoice view / PDF / create response).
const saleInclude = {
  store: { select: publicStoreSelect },
  party: true,
  customer: true,
  adjustmentLogs: true,

  items: {
    include: {
      inventory: {
        include: {
          item: true,
          product: true,
          metal: true,
          purityMaster: true,
          grade: true,
          stone: true,
        },
      },
    },
  },

  payments: true,

  oldGolds: {
    include: {
      purchase: {
        select: { id: true, invoiceNo: true, date: true, customerName: true, customerPhone: true, netPayable: true },
      },
    },
  },

  advanceAdjustments: {
    include: {
      advanceReceive: {
        select: { id: true, customerName: true, contactNumber: true, amount: true, receiveDate: true, specification: true },
      },
    },
  },
};

// List rows: everything the list and the invoice-preview modal read, without the deep
// inventory graph and adjustment logs.
const saleListInclude = {
  store: { select: publicStoreSelect },
  party: { select: { id: true, name: true, phone: true, address: true, gst: true } },
  customer: { select: { id: true, customerCode: true, name: true, phone: true, address: true, city: true, state: true, pan: true, gst: true } },
  items: {
    include: {
      inventory: {
        select: {
          id: true,
          inventoryCode: true,
          barcodeNo: true,
          tagNo: true,
          huidNo: true,
          item: { select: { id: true, name: true } },
          product: { select: { id: true, name: true } },
          metal: { select: { id: true, name: true } },
          purityMaster: { select: { id: true, name: true } },
        },
      },
    },
  },
  payments: true,
  oldGolds: { select: { id: true, purchaseId: true, description: true, value: true, adjustedAmount: true } },
  advanceAdjustments: { select: { id: true, advanceReceiveId: true, amount: true, adjustedAmount: true } },
};

export const UNPAGINATED_SALES_CAP = 500;

export const createSaleRepo = async (data, tx = prisma) => {
  return tx.sale.create({
    data,
    include: saleInclude,
  });
};

export const getSaleByIdRepo = async (id, storeId, tx = prisma) => {
  return tx.sale.findFirst({
    where: {
      id: Number(id),
      storeId: Number(storeId),
    },
    include: saleInclude,
  });
};

export const getSalesRepo = async (storeId, options = {}) => {
  const where = { storeId: Number(storeId) };
  const search = String(options.search || "").trim().slice(0, 100);
  if (search) where.OR = [
    { invoiceNo: { contains: search, mode: "insensitive" } },
    { customerName: { contains: search, mode: "insensitive" } },
    { customerPhone: { contains: search, mode: "insensitive" } },
    { party: { name: { contains: search, mode: "insensitive" } } },
  ];
  if (options.status) where.status = options.status;
  const query = {
    where,
    include: saleListInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  };
  if (Number.isInteger(options.skip)) query.skip = options.skip;
  query.take = Number.isInteger(options.take) ? options.take : UNPAGINATED_SALES_CAP;
  if (options.paginated) {
    const [sales, total] = await prisma.$transaction([
      prisma.sale.findMany(query), prisma.sale.count({ where }),
    ]);
    return { sales, total };
  }
  return prisma.sale.findMany(query);
};

export const getSaleCountRepo = async (storeId, status = "COMPLETED") => {
  return prisma.sale.count({
    where: {
      storeId: Number(storeId),
      ...(status ? { status } : {}),
    },
  });
};

export const getSalesReportRepo = async (
  storeId,
  fromDate,
  toDate,
  status = "COMPLETED"
) => {
  return prisma.sale.findMany({
    where: {
      storeId: Number(storeId),
      ...(status ? { status } : {}),
      saleDate: {
        gte: fromDate,
        lte: toDate,
      },
    },

    // Lean on purpose: an "All time" report covers thousands of invoices. Scalar sale fields
    // carry all totals; relations are reduced to what the screen / Excel / PDF read.
    include: {
      customer: { select: { id: true, customerCode: true, name: true, phone: true } },
      party: { select: { id: true, name: true, phone: true } },
      items: {
        select: {
          id: true,
          inventoryId: true,
          particulars: true,
          itemCode: true,
          huidNo: true,
          purityName: true,
          pieces: true,
          grossWeight: true,
          netWeight: true,
          rate: true,
          totalAmount: true,
        },
      },
      payments: { select: { id: true, paymentMode: true, amount: true, paymentDate: true, referenceNo: true } },
    },

    orderBy: {
      saleDate: "desc",
    },
  });
};
