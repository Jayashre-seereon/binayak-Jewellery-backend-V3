import prisma from "../config/db.js";
import * as repo from "../repositories/partyMasterRepository.js";
import { AppError, assertUniqueName, cleanString } from "../utils/validate.js";
import { assertRef, findOwned, nameChanged, rethrowDeleteError } from "../utils/errorHandler.js";

const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{13}$/;

const parseGst = (value) => {
  const gst = cleanString(value, 20);
  if (!gst) return null;
  const upper = gst.toUpperCase().replace(/\s+/g, "");
  if (!GSTIN_RE.test(upper)) throw new AppError("GSTIN must be 15 characters (e.g. 21ABCDE1234F1Z5).");
  return upper;
};

const parsePhone = (value) => {
  const raw = cleanString(value, 30);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 13) throw new AppError("Phone must be a valid 10-digit number.");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

// Whitelisted, typed fields only — storeId / id / timestamps from the body are never used.
// On update, unchanged legacy values (migrated junk like "12121") are kept as-is.
const unchanged = (incoming, stored) => String(incoming ?? "").trim() === String(stored ?? "").trim();
const buildFields = (data, existing = null) => {
  const out = {};
  if (data.gst !== undefined && !(existing && unchanged(data.gst, existing.gst))) out.gst = parseGst(data.gst);
  if (data.phone !== undefined && !(existing && unchanged(data.phone, existing.phone))) out.phone = parsePhone(data.phone);
  if (data.ledger !== undefined) out.ledger = cleanString(data.ledger, 200);
  if (data.address !== undefined) out.address = cleanString(data.address, 500);
  return out;
};

// CREATE
export const createPartyMasterService = async (data, storeId) => {
  if (data.partytypeId === undefined || data.partytypeId === null || data.partytypeId === "") throw new AppError("Party type is required.");
  const partytype = await assertRef(prisma.partytype, data.partytypeId, storeId, "Party type");
  const name = await assertUniqueName(prisma.partymaster, { storeId, name: data.name, label: "Party" });
  return repo.createPartyMasterRepo({
    name,
    ...buildFields(data),
    partytypeId: partytype.id,
    storeId: Number(storeId),
  });
};

// GET
export const getPartyMastersService = async (storeId) => repo.getPartyMastersRepo(Number(storeId));

// GET BY ID
export const getPartyMasterByIdService = async (id, storeId) =>
  findOwned(prisma.partymaster, id, storeId, "Party master", { include: { partytype: true } });

// UPDATE
export const updatePartyMasterService = async (id, data, storeId) => {
  const party = await findOwned(prisma.partymaster, id, storeId, "Party master");
  const update = buildFields(data, party);
  if (nameChanged(data.name, party.name)) {
    update.name = await assertUniqueName(prisma.partymaster, { storeId, name: data.name, excludeId: party.id, label: "Party" });
  }
  if (data.partytypeId !== undefined && data.partytypeId !== null && data.partytypeId !== "" && Number(data.partytypeId) !== party.partytypeId) {
    update.partytypeId = (await assertRef(prisma.partytype, data.partytypeId, storeId, "Party type")).id;
  }
  return repo.updatePartyMasterRepo(party.id, update);
};

// DELETE
export const deletePartyMasterService = async (id, storeId) => {
  const party = await findOwned(prisma.partymaster, id, storeId, "Party master");
  try {
    return await repo.deletePartyMasterRepo(party.id);
  } catch (error) {
    return rethrowDeleteError(error, "party");
  }
};
