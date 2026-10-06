import prisma from "../config/db.js";
import * as repo from "../repositories/gradeRepository.js";
import { AppError, assertUniqueName, cleanString } from "../utils/validate.js";
import { assertRef, findOwned, nameChanged, rethrowDeleteError } from "../utils/errorHandler.js";

/** Grade percentage (fineness) must be a number with 0 < pct <= 100. */
const parsePercentage = (value) => {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    throw new AppError("Percentage is required.");
  }
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw new AppError("Percentage must be a valid number.");
  if (n <= 0 || n > 100) throw new AppError("Percentage must be greater than 0 and at most 100.");
  return Math.round(n * 1000) / 1000;
};

// A grade name ("916") must be unique per purity within the store.
const uniqueName = (storeId, name, purityId, excludeId = null) =>
  assertUniqueName(prisma.grade, { storeId, name, excludeId, extraWhere: { purityId }, label: "Grade" });

// CREATE
export const createGradeService = async (data, storeId) => {
  if (data.purityId === undefined || data.purityId === null || data.purityId === "") throw new AppError("Purity is required.");
  const purity = await assertRef(prisma.purity, data.purityId, storeId, "Purity");
  const percentage = parsePercentage(data.percentage);
  const name = await uniqueName(storeId, data.name, purity.id);
  return repo.createGradeRepo({
    name,
    percentage,
    description: cleanString(data.description),
    purityId: purity.id,
    storeId: Number(storeId),
  });
};

// GET
export const getGradesService = async (storeId) => repo.getGradesRepo(Number(storeId));

// GET BY ID
export const getGradeByIdService = async (id, storeId) =>
  findOwned(prisma.grade, id, storeId, "Grade", { include: { purity: { include: { metal: true } } } });

// UPDATE (whitelisted: name, percentage, description, purityId)
export const updateGradeService = async (id, data, storeId) => {
  const grade = await findOwned(prisma.grade, id, storeId, "Grade");
  const update = {};

  let purityId = grade.purityId;
  if (data.purityId !== undefined && data.purityId !== null && data.purityId !== "" && Number(data.purityId) !== grade.purityId) {
    purityId = (await assertRef(prisma.purity, data.purityId, storeId, "Purity")).id;
    update.purityId = purityId;
  }
  if (data.percentage !== undefined) update.percentage = parsePercentage(data.percentage);
  if (nameChanged(data.name, grade.name) || update.purityId) {
    update.name = await uniqueName(storeId, data.name ?? grade.name, purityId, grade.id);
  }
  if (data.description !== undefined) update.description = cleanString(data.description);

  return repo.updateGradeRepo(grade.id, update);
};

// DELETE
export const deleteGradeService = async (id, storeId) => {
  const grade = await findOwned(prisma.grade, id, storeId, "Grade");
  try {
    return await repo.deleteGradeRepo(grade.id);
  } catch (error) {
    return rethrowDeleteError(error, "grade");
  }
};

// GET ALL GRADES BY PURITY ID
export const getGradesByPurityIdService = async (purityId, storeId) => {
  if (!Number.isInteger(Number(purityId)) || Number(purityId) <= 0) throw new AppError("Purity ID is required.");
  return repo.getGradesByPurityIdRepo(Number(purityId), Number(storeId));
};
