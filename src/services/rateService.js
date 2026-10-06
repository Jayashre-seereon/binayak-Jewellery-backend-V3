import prisma from "../config/db.js";
import * as repo from "../repositories/rateRepository.js";
import { AppError, toNumber, parseId, optionalId, toDate, cleanString, roundMoney } from "../utils/validate.js";

const RATE_FIELDS = ["metalId", "purityId", "gradeId", "unit", "saleRate", "exchangeRate", "cashRate", "effectiveDate"];

const assertInStore = async (delegate, id, storeId, label) => {
  const row = await delegate.findFirst({ where: { id, storeId }, select: { id: true } });
  if (!row) throw new AppError(`The selected ${label} does not belong to this store.`);
};

/** Validates a full rate payload (create, or existing row merged with an update). */
const buildRateData = async (input, storeId) => {
  const metalId = parseId(input.metalId, "metal");
  const purityId = parseId(input.purityId, "purity");
  // Purity-level rates are valid, so grade is optional (MST-07).
  const gradeId = optionalId(input.gradeId, "grade");

  await assertInStore(prisma.metal, metalId, storeId, "metal");
  await assertInStore(prisma.purity, purityId, storeId, "purity");
  if (gradeId) await assertInStore(prisma.grade, gradeId, storeId, "grade");

  const saleRate = roundMoney(toNumber(input.saleRate, { field: "Sale rate", required: true, max: 1e8 }));
  if (saleRate <= 0) throw new AppError("Sale rate must be greater than zero.");
  const exchangeRate = roundMoney(toNumber(input.exchangeRate, { field: "Exchange rate", max: 1e8 }));
  const cashRate = roundMoney(toNumber(input.cashRate, { field: "Cash rate", max: 1e8 }));

  return {
    metalId,
    purityId,
    gradeId,
    unit: (cleanString(input.unit, 20) || "GRAM").toUpperCase(),
    saleRate,
    exchangeRate,
    cashRate,
    effectiveDate: toDate(input.effectiveDate, { field: "Effective date", allowFutureDays: 31 }),
  };
};

const loadOwnRate = async (id, storeId) => {
  const rate = await repo.getRateByIdRepo(parseId(id, "rate id"));
  if (!rate || rate.storeId !== Number(storeId)) throw new AppError("Rate not found.", 404);
  return rate;
};

// CREATE
export const createRateService = async (data, storeId) => {
  if (!storeId) throw new AppError("Please select a store.");
  const rateData = await buildRateData(data || {}, Number(storeId));
  return repo.createRateRepo({ ...rateData, storeId: Number(storeId) });
};

// GET (latest effective first; ?latest=1 keeps only the current rate per metal/purity/grade/unit)
export const getRatesService = async (storeId, { latest = false, asOf } = {}) => {
  const asOfDate = asOf ? toDate(asOf, { field: "asOf", allowFutureDays: null }) : null;
  const rates = await repo.getRatesRepo(Number(storeId), { asOf: asOfDate });
  if (!latest) return rates;
  const seen = new Set();
  return rates.filter((r) => {
    const key = `${r.metalId}|${r.purityId}|${r.gradeId ?? ""}|${r.unit}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// GET BY ID
export const getRateByIdService = async (id, storeId) => loadOwnRate(id, storeId);

// UPDATE (whitelisted fields only; storeId/id/timestamps in the body are ignored)
export const updateRateService = async (id, data, storeId) => {
  const rate = await loadOwnRate(id, storeId);
  const body = data || {};
  const merged = {};
  for (const k of RATE_FIELDS) merged[k] = Object.prototype.hasOwnProperty.call(body, k) ? body[k] : rate[k];
  const rateData = await buildRateData(merged, Number(storeId));
  return repo.updateRateRepo(rate.id, rateData);
};

// DELETE
export const deleteRateService = async (id, storeId) => {
  const rate = await loadOwnRate(id, storeId);
  try {
    return await repo.deleteRateRepo(rate.id);
  } catch (error) {
    if (error?.code === "P2003") throw new AppError("This rate is linked with other records and cannot be deleted.", 409);
    throw error;
  }
};
