import prisma from "../config/db.js";

const withLinks = { _count: { select: { vouchers: true, saleAdjustments: true } } };

export const createAdvanceReceiveRepo = async (data, tx = prisma) => {
  return tx.advanceReceive.create({
    data,
  });
};

export const getAdvanceReceivesRepo = async (storeId) => {
  return prisma.advanceReceive.findMany({
    where: {
      storeId,
    },
    orderBy: {
      id: "desc",
    },
  });
};

/** Matches the last 10 digits so "+91 98…" and "98…" find the same customer. */
export const getAdvanceReceivesByContactRepo = async (storeId, contactNumber) => {
  return prisma.advanceReceive.findMany({
    where: {
      storeId,
      contactNumber: {
        endsWith: contactNumber,
      },
    },
    orderBy: {
      id: "desc",
    },
  });
};

export const getAdvanceReceiveByIdRepo = async (id, storeId, tx = prisma) => {
  return tx.advanceReceive.findFirst({
    where: {
      id,
      storeId,
    },
    include: withLinks,
  });
};

/** `guard` = values read earlier; the write only lands if they are unchanged (optimistic check). */
export const updateAdvanceReceiveRepo = async (id, storeId, data, tx = prisma, guard = {}) => {
  return tx.advanceReceive.updateMany({
    where: {
      id,
      storeId,
      ...guard,
      saleAdjustments: { none: {} },
      vouchers: { none: {} },
    },
    data,
  });
};

export const deleteAdvanceReceiveRepo = async (id, storeId, tx = prisma, guard = {}) => {
  return tx.advanceReceive.deleteMany({
    where: {
      id,
      storeId,
      ...guard,
      saleAdjustments: { none: {} },
      vouchers: { none: {} },
    },
  });
};
