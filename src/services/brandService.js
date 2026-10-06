import prisma from "../config/db.js";
import {
  createBrandRepo,
  getBrandsByStore,
  updateBrandRepo,
  deleteBrandRepo,
} from "../repositories/brandRepository.js";
import { assertUniqueName, cleanString } from "../utils/validate.js";
import { findOwned, nameChanged, rethrowDeleteError } from "../utils/errorHandler.js";

// CREATE
export const createBrand = async (data, storeId) => {
  const name = await assertUniqueName(prisma.brand, { storeId, name: data.name, label: "Brand" });
  return createBrandRepo({ name, description: cleanString(data.description), storeId: Number(storeId) });
};

// GET ALL
export const getBrands = async (storeId) => getBrandsByStore(Number(storeId));

// GET BY ID
export const getBrandById = async (id, storeId) => findOwned(prisma.brand, id, storeId, "Brand");

// UPDATE
export const updateBrand = async (id, data, storeId) => {
  const brand = await findOwned(prisma.brand, id, storeId, "Brand");
  const update = {};
  if (nameChanged(data.name, brand.name)) {
    update.name = await assertUniqueName(prisma.brand, { storeId, name: data.name, excludeId: brand.id, label: "Brand" });
  } else if (data.name !== undefined) {
    update.name = String(data.name).trim();
  }
  if (data.description !== undefined) update.description = cleanString(data.description);
  return updateBrandRepo(brand.id, update);
};

// DELETE
export const deleteBrand = async (id, storeId) => {
  const brand = await findOwned(prisma.brand, id, storeId, "Brand");
  try {
    return await deleteBrandRepo(brand.id);
  } catch (error) {
    return rethrowDeleteError(error, "brand");
  }
};
