import prisma from "../config/db.js";

export const createPurityRepo = (data) => {
  return prisma.purity.create({ data });
};

export const getPuritiesRepo = (storeId) => {
  return prisma.purity.findMany({
    where: { storeId },
    include: { metal: true },
  });
};

export const getPurityByIdRepo = (id) => {
  return prisma.purity.findUnique({
    where: { id },
    include: { metal: true },
  });
};

export const updatePurityRepo = (id, data) => {
  return prisma.purity.update({
    where: { id },
    data,
  });
};

export const deletePurityRepo = (id) => {
  return prisma.purity.delete({
    where: { id },
  });
};

export const getPuritiesByMetalIdRepo = (metalId, storeId) => {
  return prisma.purity.findMany({
    where: {
      metalId,
      storeId,
    },
    include: {
      metal: true,
    },
    orderBy: {
      id: "asc",
    },
  });
};