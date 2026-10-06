import prisma from "../config/db.js";
import { publicStoreSelect } from "../utils/publicSelect.js";

const purchaseItemInclude = {
  item: {
    include: {
      product: {
        include: {
          category: true,
          metal: true,
          purity: true,
          grade: true,
        },
      },
      design: true,
    },
  },
  product: {
    include: {
      category: true,
      metal: true,
      purity: true,
      grade: true,
    },
  },
  metal: true,
  purityMaster: true,
  grade: true,
  stone: true,
};

export const purchaseFullInclude = {
  party: true,
  employee: true,
  store: { select: publicStoreSelect },
  payments: { orderBy: { id: "asc" } },
  items: {
    include: purchaseItemInclude,
    orderBy: { id: "asc" },
  },
};

export const createPurchaseRepo = async (data, client = prisma) => {
  return client.purchase.create({
    data,
    include: purchaseFullInclude,
  });
};

/** List rows: header + payments only. Lines are summarised (opening-stock purchases carry thousands). */
const purchaseListInclude = {
  party: true,
  employee: true,
  store: { select: publicStoreSelect },
  payments: { orderBy: { id: "asc" } },
  _count: { select: { items: true } },
};

const attachItemSummaries = async (rows) => {
  if (!rows.length) return rows;
  const sums = await prisma.purchaseItem.groupBy({
    by: ["purchaseId"],
    where: { purchaseId: { in: rows.map((r) => r.id) } },
    _sum: { pieces: true, grossWeight: true, netWeight: true },
    _count: { _all: true },
  });
  const byId = new Map(sums.map((g) => [g.purchaseId, g]));
  return rows.map(({ _count, ...r }) => {
    const g = byId.get(r.id);
    return {
      ...r,
      itemsSummary: {
        count: g?._count?._all ?? _count?.items ?? 0,
        pieces: Number(g?._sum?.pieces || 0),
        grossWeight: Number(Number(g?._sum?.grossWeight || 0).toFixed(3)),
        netWeight: Number(Number(g?._sum?.netWeight || 0).toFixed(3)),
      },
    };
  });
};

export const getPurchasesByStore = async (storeId, options = {}) => {
  const where = { storeId: Number(storeId) };
  if (options.purchaseType) where.purchaseType = options.purchaseType;
  const search = String(options.search || "").trim();
  if (search) where.OR = [
    { invoiceNo: { contains: search, mode: "insensitive" } },
    { referenceNo: { contains: search, mode: "insensitive" } },
    { customerName: { contains: search, mode: "insensitive" } },
    { customerPhone: { contains: search, mode: "insensitive" } },
    { party: { name: { contains: search, mode: "insensitive" } } },
  ];
  const query = {
    where,
    include: purchaseListInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  };
  if (Number.isInteger(options.skip)) query.skip = options.skip;
  if (Number.isInteger(options.take)) query.take = options.take;
  if (options.paginated) {
    const [purchases, total] = await prisma.$transaction([
      prisma.purchase.findMany(query), prisma.purchase.count({ where }),
    ]);
    return { purchases: await attachItemSummaries(purchases), total };
  }
  return attachItemSummaries(await prisma.purchase.findMany(query));
};

/** Open OLD-gold purchases of a seller (PUR-26): only those that still have value to adjust. */
export const getPurchasesByStoreAndPhone = async (storeId, phone) => {
  const last10 = String(phone || "").replace(/\D/g, "").slice(-10);
  return prisma.purchase.findMany({
    where: {
      storeId: Number(storeId),
      purchaseType: "OLD",
      balanceAmount: { gt: 0.01 },
      adjustmentStatus: { notIn: ["FULLY_ADJUSTED", "SETTLED"] },
      OR: [
        { customerPhone: { endsWith: last10 } },
        { party: { phone: { endsWith: last10 } } },
      ],
    },
    include: purchaseFullInclude,
    orderBy: [{ date: "desc" }, { id: "desc" }],
  });
};

export const getPurchaseByIdRepo = async (id, client = prisma) => {
  return client.purchase.findUnique({
    where: {
      id: Number(id),
    },
    include: purchaseFullInclude,
  });
};

export const getPurchaseItemsByPurchaseIdRepo = async (purchaseId, storeId, { withoutInventory = false } = {}) => {
  return prisma.purchaseItem.findMany({
    where: {
      purchaseId: Number(purchaseId),
      purchase: {
        storeId: Number(storeId),
      },
      ...(withoutInventory ? { inventory: { none: {} } } : {}),
    },
    include: {
      ...purchaseItemInclude,
      purchase: {
        select: {
          id: true,
          invoiceNo: true,
          purchaseType: true,
        },
      },
    },
    orderBy: {
      id: "asc",
    },
  });
};

/** Purchases that still have lines without an inventory tag (INV-16), lean shape. */
export const getPurchasesPendingInventoryRepo = async (storeId, { purchaseType, search, take = 200 } = {}) => {
  const s = String(search || "").trim();
  return prisma.purchase.findMany({
    where: {
      storeId: Number(storeId),
      ...(purchaseType ? { purchaseType } : {}),
      items: { some: { inventory: { none: {} } } },
      ...(s
        ? {
            OR: [
              { invoiceNo: { contains: s, mode: "insensitive" } },
              { customerName: { contains: s, mode: "insensitive" } },
              { party: { name: { contains: s, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      invoiceNo: true,
      purchaseType: true,
      date: true,
      customerName: true,
      party: { select: { id: true, name: true } },
      items: {
        where: { inventory: { none: {} } },
        orderBy: { id: "asc" },
        select: {
          id: true,
          purchaseItemCode: true,
          pieces: true,
          grossWeight: true,
          stoneWeight: true,
          netWeight: true,
          huidNo: true,
          item: { select: { id: true, name: true } },
          product: { select: { id: true, name: true } },
          metal: { select: { id: true, name: true } },
          purityMaster: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take,
  });
};

export const updatePurchaseRepo = async (id, data, client = prisma) => {
  return client.purchase.update({
    where: {
      id: Number(id),
    },
    data,
    include: purchaseFullInclude,
  });
};

export const deletePurchaseRepo = async (id, client = prisma) => {
  return client.purchase.delete({
    where: {
      id: Number(id)
    }
  });
};

export const countPurchases = async (storeId) => {
  return prisma.purchase.count({
    where: {
      storeId: Number(storeId)
    }
  });
};

export const getPurchaseReportRepo = async (
  storeId,
  fromDate,
  toDate,
  purchaseType
) => {
  return prisma.purchase.findMany({
    where: {
      storeId: Number(storeId),

      ...(purchaseType &&
      purchaseType !== "ALL" &&
      purchaseType !== ""
        ? {
            purchaseType,
          }
        : {}),

      date: {
        gte: fromDate,
        lte: toDate,
      },
    },

    include: {
      party: true,
      customer: true,
      employee: true,
      // report rows only need line weights/purity (opening-stock purchases have thousands of lines)
      items: {
        select: {
          id: true, pieces: true, grossWeight: true, stoneWeight: true, netWeight: true,
          pureWeight: true, purity: true, rate: true, totalAmount: true,
          item: { select: { id: true, name: true } },
          product: { select: { id: true, name: true } },
          metal: { select: { id: true, name: true } },
          purityMaster: { select: { id: true, name: true } },
        },
      },
      payments: true,
    },

    orderBy: {
      date: "desc",
    },
  });
};
