import prisma from "../config/db.js";

// CREATE
export const createPartyMasterRepo = (data) => {
  return prisma.partymaster.create({ data });
};

// GET ALL
export const getPartyMastersRepo = (storeId) => {
  return prisma.partymaster.findMany({
    where: { storeId },
    include: {
        partytype: true,
    },
  });
};
// GET BY ID
export const getPartyMasterByIdRepo = (id) => {
  return prisma.partymaster.findUnique({
    where: { id },
    include: {
        partytype: true,
    },
  });
};
         

// UPDATE
export const updatePartyMasterRepo = (id, data) => {
  return prisma.partymaster.update({
    where: { id },
    data,
  });
};

// DELETE
export const deletePartyMasterRepo = (id) => {
  return prisma.partymaster.delete({
    where: { id },
  });
};