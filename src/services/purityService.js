import prisma from "../config/db.js";
import * as repo from "../repositories/purityRepository.js";
import { AppError, assertUniqueName, cleanString } from "../utils/validate.js";
import { assertRef, findOwned, nameChanged, rethrowDeleteError } from "../utils/errorHandler.js";

// A purity name ("22K") must be unique per metal within the store.
const uniqueName = (storeId, name, metalId, excludeId = null) =>
  assertUniqueName(prisma.purity, { storeId, name, excludeId, extraWhere: { metalId }, label: "Purity" });

export const createPurity = async (data, storeId) => {
  if (data.metalId === undefined || data.metalId === null || data.metalId === "") throw new AppError("Metal is required.");
  const metal = await assertRef(prisma.metal, data.metalId, storeId, "Metal");
  const name = await uniqueName(storeId, data.name, metal.id);
  return repo.createPurityRepo({
    name,
    description: cleanString(data.description),
    metalId: metal.id,
    storeId: Number(storeId),
  });
};

export const getPurities = async (storeId) => repo.getPuritiesRepo(Number(storeId));

export const getPurityById = async (id, storeId) =>
  findOwned(prisma.purity, id, storeId, "Purity", { include: { metal: true } });

// Only name, description and metal can change; storeId/id/timestamps in the body are ignored.
export const updatePurity = async (id, data, storeId) => {
  const purity = await findOwned(prisma.purity, id, storeId, "Purity");
  const update = {};

  let metalId = purity.metalId;
  if (data.metalId !== undefined && data.metalId !== null && data.metalId !== "" && Number(data.metalId) !== purity.metalId) {
    metalId = (await assertRef(prisma.metal, data.metalId, storeId, "Metal")).id;
    update.metalId = metalId;
  }
  if (nameChanged(data.name, purity.name) || update.metalId) {
    update.name = await uniqueName(storeId, data.name ?? purity.name, metalId, purity.id);
  }
  if (data.description !== undefined) update.description = cleanString(data.description);

  return repo.updatePurityRepo(purity.id, update);
};

export const deletePurity = async (id, storeId) => {
  const purity = await findOwned(prisma.purity, id, storeId, "Purity");
  try {
    return await repo.deletePurityRepo(purity.id);
  } catch (error) {
    return rethrowDeleteError(error, "purity");
  }
};

export const getPuritiesByMetalId = async (metalId, storeId) => {
  if (!Number.isInteger(Number(metalId)) || Number(metalId) <= 0) throw new AppError("Metal ID is required.");
  return repo.getPuritiesByMetalIdRepo(Number(metalId), Number(storeId));
};
