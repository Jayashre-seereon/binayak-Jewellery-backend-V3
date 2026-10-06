import prisma from "../config/db.js";
import {
  createPartyTypeRepo,
  getPartyTypesByStore,
  updatePartyTypeRepo,
  deletePartyTypeRepo,
} from "../repositories/partytypeRepository.js";
import { assertUniqueName, cleanString } from "../utils/validate.js";
import { findOwned, nameChanged, rethrowDeleteError } from "../utils/errorHandler.js";

// CREATE
export const createPartyType = async (data, storeId) => {
  const name = await assertUniqueName(prisma.partytype, { storeId, name: data.name, label: "Party type" });
  return createPartyTypeRepo({ name, description: cleanString(data.description), storeId: Number(storeId) });
};

// GET ALL
export const getPartyTypes = async (storeId) => getPartyTypesByStore(Number(storeId));

// GET BY ID
export const getPartyTypeById = async (id, storeId) => findOwned(prisma.partytype, id, storeId, "Party type");

// UPDATE
export const updatePartyType = async (id, data, storeId) => {
  const partytype = await findOwned(prisma.partytype, id, storeId, "Party type");
  const update = {};
  if (nameChanged(data.name, partytype.name)) {
    update.name = await assertUniqueName(prisma.partytype, { storeId, name: data.name, excludeId: partytype.id, label: "Party type" });
  } else if (data.name !== undefined) {
    update.name = String(data.name).trim();
  }
  if (data.description !== undefined) update.description = cleanString(data.description);
  return updatePartyTypeRepo(partytype.id, update);
};

// DELETE
export const deletePartyType = async (id, storeId) => {
  const partytype = await findOwned(prisma.partytype, id, storeId, "Party type");
  try {
    return await deletePartyTypeRepo(partytype.id);
  } catch (error) {
    return rethrowDeleteError(error, "party type");
  }
};
