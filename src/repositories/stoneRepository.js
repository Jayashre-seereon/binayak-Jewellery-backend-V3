import prisma from "../config/db.js";

export const createStoneRepo = (data) => {
  return prisma.stone.create({
    data,
  });
};

export const getStonesByStore = (storeId) => {
  return prisma.stone.findMany({
    where: { storeId },
    include: {
      product: true,
      item: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });
};

export const getStonesByProductIdAndItemIdRepo = (productId, itemId, storeId) => {
  return prisma.stone.findMany({
    where: {
      productId,
      itemId,
      storeId,
    },
    include: {
      product: true,
      item: true,
    },
    orderBy: {
      id: "asc",
    },
  });
};

export const getStoneByIdRepo = (id) => {
  return prisma.stone.findUnique({
    where: { id },
    include: {
      product: true,
      item: true,
    },
  });
};

export const updateStoneRepo = (id, data) => {
  return prisma.stone.update({
    where: { id },
    data,
  });
};

export const deleteStoneRepo = (id) => {
  return prisma.stone.delete({
    where: { id },
  });
};
