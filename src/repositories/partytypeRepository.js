import prisma from "../config/db.js";

export const createPartyTypeRepo = (data) => {
  return prisma.partytype.create({ data });
};

export const getPartyTypesByStore = (storeId) => {
  return prisma.partytype.findMany({
    where: { storeId },
  });
};

export const getPartyTypeByIdRepo = (id)=>{
  return prisma.partytype.findUnique({
    where:{
      id
    }
  });
};

export const updatePartyTypeRepo = (id, data) => {
  return prisma.partytype.update({
    where: { id },
    data,
  });
};

export const deletePartyTypeRepo = (id) => {
  return prisma.partytype.delete({
    where: { id },
  });
};
