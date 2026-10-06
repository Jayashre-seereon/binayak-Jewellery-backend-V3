import prisma from "../config/db.js";
import {
  createDesignRepo,
  getDesignsByStore,
  updateDesignRepo,
  deleteDesignRepo,
} from "../repositories/designRepository.js";
import { assertUniqueName, cleanString } from "../utils/validate.js";
import { findOwned, nameChanged, rethrowDeleteError } from "../utils/errorHandler.js";

// CREATE
export const createDesign = async (data, storeId) => {
  const name = await assertUniqueName(prisma.design, { storeId, name: data.name, label: "Design" });
  return createDesignRepo({
    name,
    description: cleanString(data.description),
    image: data.image || null,
    storeId: Number(storeId),
  });
};

// GET ALL
export const getDesigns = async (storeId) => getDesignsByStore(Number(storeId));

// GET BY ID
export const getDesignById = async (id, storeId) => findOwned(prisma.design, id, storeId, "Design");

// UPDATE
export const updateDesign = async (id, data, storeId) => {
  const design = await findOwned(prisma.design, id, storeId, "Design");
  const update = {};
  if (nameChanged(data.name, design.name)) {
    update.name = await assertUniqueName(prisma.design, { storeId, name: data.name, excludeId: design.id, label: "Design" });
  } else if (data.name !== undefined) {
    update.name = String(data.name).trim();
  }
  if (data.description !== undefined) update.description = cleanString(data.description);
  if (data.image !== undefined) update.image = data.image;
  return updateDesignRepo(design.id, update);
};

// DELETE
export const deleteDesign = async (id, storeId) => {
  const design = await findOwned(prisma.design, id, storeId, "Design");
  try {
    return await deleteDesignRepo(design.id);
  } catch (error) {
    return rethrowDeleteError(error, "design");
  }
};
