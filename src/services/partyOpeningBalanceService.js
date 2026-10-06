import prisma from "../config/db.js";
import * as repo from "../repositories/partyOpeningBalanceRepository.js";
import { AppError, toNumber, parseId, cleanString, roundWeight } from "../utils/validate.js";

const FIELDS = ["partymasterId", "metalId", "type", "year", "debit", "credit"];

/**
 * Validates a full opening-balance payload. Amounts may carry decimals (rupees and paise, or
 * grams to 3 places) and exactly one of debit / credit must be set (PUR-23).
 */
const buildData = async (input, storeId, excludeId = null) => {
  const partymasterId = parseId(input.partymasterId, "party");
  const metalId = parseId(input.metalId, "metal");
  const type = cleanString(input.type, 50);
  const year = cleanString(input.year, 20);
  if (!type) throw new AppError("Opening balance type is required.");
  if (!year) throw new AppError("Year is required.");

  const [party, metal] = await Promise.all([
    prisma.partymaster.findFirst({ where: { id: partymasterId, storeId }, select: { id: true } }),
    prisma.metal.findFirst({ where: { id: metalId, storeId }, select: { id: true } }),
  ]);
  if (!party) throw new AppError("The selected party does not belong to this store.");
  if (!metal) throw new AppError("The selected metal does not belong to this store.");

  const debit = roundWeight(toNumber(input.debit, { field: "Debit", max: 1e11 }));
  const credit = roundWeight(toNumber(input.credit, { field: "Credit", max: 1e11 }));
  if ((debit > 0) === (credit > 0)) throw new AppError("Enter either a debit or a credit opening balance (exactly one).");

  const duplicate = await prisma.partyOpeningBalance.findFirst({
    where: { storeId, partymasterId, metalId, year, type, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    select: { id: true },
  });
  if (duplicate) throw new AppError("An opening balance for this party, metal, type and year already exists.", 409);

  return { partymasterId, metalId, type, year, debit: debit > 0 ? debit : 0, credit: credit > 0 ? credit : 0 };
};

const loadOwn = async (id, storeId) => {
  const row = await repo.getPartyOpeningBalanceByIdRepo(parseId(id, "opening balance id"));
  if (!row || row.storeId !== Number(storeId)) throw new AppError("Party opening balance not found.", 404);
  return row;
};

// CREATE
export const createPartyOpeningBalanceService = async (data, storeId) => {
  if (!storeId) throw new AppError("Please select a store.");
  const clean = await buildData(data || {}, Number(storeId));
  return repo.createPartyOpeningBalanceRepo({ ...clean, storeId: Number(storeId) });
};

// GET
export const getPartyOpeningBalancesService = async (storeId) => {
  return repo.getPartyOpeningBalancesRepo(Number(storeId));
};

// GET BY ID
export const getPartyOpeningBalanceByIdService = async (id, storeId) => loadOwn(id, storeId);

// UPDATE (whitelisted fields only)
export const updatePartyOpeningBalanceService = async (id, data, storeId) => {
  const row = await loadOwn(id, storeId);
  const body = data || {};
  const merged = {};
  for (const k of FIELDS) merged[k] = Object.prototype.hasOwnProperty.call(body, k) ? body[k] : row[k];
  // Switching sides: when the client sends only the new side, clear the other one.
  if (Object.prototype.hasOwnProperty.call(body, "debit") && !Object.prototype.hasOwnProperty.call(body, "credit") && Number(body.debit) > 0) merged.credit = 0;
  if (Object.prototype.hasOwnProperty.call(body, "credit") && !Object.prototype.hasOwnProperty.call(body, "debit") && Number(body.credit) > 0) merged.debit = 0;
  const clean = await buildData(merged, Number(storeId), row.id);
  return repo.updatePartyOpeningBalanceRepo(row.id, clean);
};

// DELETE
export const deletePartyOpeningBalanceService = async (id, storeId) => {
  const row = await loadOwn(id, storeId);
  try {
    return await repo.deletePartyOpeningBalanceRepo(row.id);
  } catch (error) {
    if (error?.code === "P2003") throw new AppError("This opening balance is linked with other records and cannot be deleted.", 409);
    throw error;
  }
};
