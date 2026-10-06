import prisma from "../config/db.js";

// CREATE
export const createPartyOpeningBalanceRepo = (data) => {
  return prisma.partyOpeningBalance.create({ data });
};

// GET ALL
export const getPartyOpeningBalancesRepo = (storeId) => {
  return prisma.partyOpeningBalance.findMany({
    where: { storeId },
    include: {
      partymaster: true,
      metal: true,
    },
    orderBy: { id: "desc" },
  });
};

// GET BY ID
export const getPartyOpeningBalanceByIdRepo = (id) => {
  return prisma.partyOpeningBalance.findUnique({
    where: { id },
    include: {
      partymaster: true,
      metal: true,
    },
  });
};

// UPDATE
export const updatePartyOpeningBalanceRepo = (id, data) => {
  return prisma.partyOpeningBalance.update({
    where: { id },
    data,
  });
};

// DELETE
export const deletePartyOpeningBalanceRepo = (id) => {
  return prisma.partyOpeningBalance.delete({
    where: { id },
  });
};