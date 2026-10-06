import prisma from "../config/db.js";

export const createBrandRepo = (data) => {
  return prisma.brand.create({ data });
};

export const getBrandsByStore = (storeId) => {
  return prisma.brand.findMany({
    where: { storeId },
  });
};

export const getBrandByIdRepo = (id)=>{
  return prisma.brand.findUnique({
    where:{
      id
    }
  });
};

export const updateBrandRepo = (id, data) => {
  return prisma.brand.update({
    where: { id },
    data,
  });
};

export const deleteBrandRepo = (id) => {
  return prisma.brand.delete({
    where: { id },
  });
};
