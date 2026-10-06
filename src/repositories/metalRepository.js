import prisma from "../config/db.js";

export const createMetalRepo = (data) => {
  return prisma.metal.create({ data });
};

export const getMetalsByStore = (storeId) => {
  return prisma.metal.findMany({
    where: { storeId },
  });
};

export const getMetalByIdRepo = (id) => {
  return prisma.metal.findUnique({
    where: { id },
  });
};

export const updateMetalRepo = (id, data) => {
  return prisma.metal.update({
    where: { id },
    data,
  });
};

export const deleteMetalRepo = (id) => {
  return prisma.metal.delete({
    where: { id },
  });
};