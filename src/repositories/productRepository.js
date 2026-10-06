import prisma from "../config/db.js";

export const productInclude = {
  category: true,
  metal: true,
  purity: true,
  grade: true,
};

export const createProductRepo = (data) => {
  return prisma.product.create({ data, include: productInclude });
};

export const getProductsByStore = (storeId) => {
  return prisma.product.findMany({
    where: { storeId },
    include: productInclude,
    orderBy: { id: "desc" },
  });
};

export const getProductsByMetalIdRepo = (metalId, storeId) => {
  return prisma.product.findMany({
    where: { metalId, storeId },
    include: productInclude,
    orderBy: { id: "asc" },
  });
};

export const getProductByIdRepo = (id, storeId) => {
  return prisma.product.findFirst({
    where: { id, ...(storeId ? { storeId } : {}) },
    include: productInclude,
  });
};

export const updateProductRepo = (id, data) => {
  return prisma.product.update({ where: { id }, data, include: productInclude });
};

export const deleteProductRepo = (id) => {
  return prisma.product.delete({ where: { id } });
};

export const countProducts = async () => {
  return prisma.product.count();
};
