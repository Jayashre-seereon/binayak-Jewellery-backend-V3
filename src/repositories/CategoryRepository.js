import prisma from "../config/db.js";

export const createCategoryRepo = (data) => {
  return prisma.category.create({ data });
};

export const getCategoriesByStore = (storeId) => {
  return prisma.category.findMany({
    where: { storeId },
  });
};

export const getCategoryByIdRepo = (id) => {
  return prisma.category.findUnique({
    where: { id },
  });
};

export const updateCategoryRepo = (id, data) => {
  return prisma.category.update({
    where: { id },
    data,
  });
};

export const deleteCategoryRepo = (id) => {
  return prisma.category.delete({
    where: { id },
  });
};