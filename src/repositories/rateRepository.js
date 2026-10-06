import prisma from "../config/db.js";

const rateInclude = {
  metal: true,
  purity: true,
  grade: true,
};

// Create a new rate
export const createRateRepo = (data) => {
  return prisma.rateMaster.create({
    data,
    include: rateInclude,
  });
};

// Get all rates of a store, latest effective rate first (PUR-17 / MST-07)
export const getRatesRepo = (storeId, { asOf = null } = {}) => {
  return prisma.rateMaster.findMany({
    where: { storeId, ...(asOf ? { effectiveDate: { lte: asOf } } : {}) },
    include: rateInclude,
    orderBy: [{ effectiveDate: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
  });
};

// Get rate by ID
export const getRateByIdRepo = (id) => {
  return prisma.rateMaster.findUnique({
    where: { id },
    include: rateInclude,
  });
};

// Update rate
export const updateRateRepo = (id, data) => {
  return prisma.rateMaster.update({
    where: { id },
    data,
    include: rateInclude,
  });
};

// Delete rate
export const deleteRateRepo = (id) => {
  return prisma.rateMaster.delete({
    where: { id },
  });
};
