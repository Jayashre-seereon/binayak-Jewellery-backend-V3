import prisma from "../config/db.js";

export const createDesignRepo = (data) => {
  return prisma.design.create({
    data,
  });
};

export const getDesignsByStore = (storeId) => {
  return prisma.design.findMany({
    where: { storeId },
    orderBy: {
      id: "desc",
    },
  });
};

export const getDesignByIdRepo = (id)=>{
  return prisma.design.findUnique({
    where:{
      id
    },
  });
};

export const updateDesignRepo = (id, data) => {
  return prisma.design.update({
    where: { id },
    data,
  });
};

export const deleteDesignRepo = (id) => {
  return prisma.design.delete({
    where: { id },
  });
};
