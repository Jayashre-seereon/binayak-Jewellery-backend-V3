import prisma from "../config/db.js";
import {
  createMetalRepo,
  getMetalsByStore,
  updateMetalRepo,
  deleteMetalRepo,
} from "../repositories/metalRepository.js";
import { assertUniqueName, cleanString } from "../utils/validate.js";
import { findOwned, nameChanged, rethrowDeleteError } from "../utils/errorHandler.js";

// CREATE
export const createMetal = async (data, storeId) => {
  const name = await assertUniqueName(prisma.metal, { storeId, name: data.name, label: "Metal" });
  return createMetalRepo({ name, description: cleanString(data.description), storeId: Number(storeId) });
};

// GET ALL
export const getMetals = async (storeId) => getMetalsByStore(Number(storeId));

// GET BY ID
export const getMetalById = async (id, storeId) => findOwned(prisma.metal, id, storeId, "Metal");

// UPDATE
export const updateMetal = async (id, data, storeId) => {
  const metal = await findOwned(prisma.metal, id, storeId, "Metal");
  const update = {};
  if (nameChanged(data.name, metal.name)) {
    update.name = await assertUniqueName(prisma.metal, { storeId, name: data.name, excludeId: metal.id, label: "Metal" });
  } else if (data.name !== undefined) {
    update.name = String(data.name).trim();
  }
  if (data.description !== undefined) update.description = cleanString(data.description);
  return updateMetalRepo(metal.id, update);
};

// DELETE
export const deleteMetal = async (id, storeId) => {
  const metal = await findOwned(prisma.metal, id, storeId, "Metal");
  try {
    return await deleteMetalRepo(metal.id);
  } catch (error) {
    return rethrowDeleteError(error, "metal");
  }
};
