import prisma from "../config/db.js";
import {
  createCategoryRepo,
  getCategoriesByStore,
  updateCategoryRepo,
  deleteCategoryRepo,
} from "../repositories/CategoryRepository.js";
import { assertUniqueName, cleanString } from "../utils/validate.js";
import { findOwned, nameChanged, rethrowDeleteError } from "../utils/errorHandler.js";

// CREATE
export const createCategory = async (data, storeId) => {
  const name = await assertUniqueName(prisma.category, { storeId, name: data.name, label: "Category" });
  return createCategoryRepo({ name, description: cleanString(data.description), storeId: Number(storeId) });
};

// GET ALL
export const getCategories = async (storeId) => getCategoriesByStore(Number(storeId));

// GET BY ID
export const getCategoryById = async (id, storeId) => findOwned(prisma.category, id, storeId, "Category");

// UPDATE
export const updateCategory = async (id, data, storeId) => {
  const category = await findOwned(prisma.category, id, storeId, "Category");
  const update = {};
  if (nameChanged(data.name, category.name)) {
    update.name = await assertUniqueName(prisma.category, { storeId, name: data.name, excludeId: category.id, label: "Category" });
  } else if (data.name !== undefined) {
    update.name = String(data.name).trim();
  }
  if (data.description !== undefined) update.description = cleanString(data.description);
  return updateCategoryRepo(category.id, update);
};

// DELETE
export const deleteCategory = async (id, storeId) => {
  const category = await findOwned(prisma.category, id, storeId, "Category");
  try {
    return await deleteCategoryRepo(category.id);
  } catch (error) {
    return rethrowDeleteError(error, "category");
  }
};
