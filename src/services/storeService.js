import bcrypt from "bcryptjs";
import {
  createStoreRepo, updateStoreRepo, getAllStoresRepo, getStoreByIdRepo, deleteStoreRepo, getStoreOptionsRepo,
} from "../repositories/storeRepository.js";
import { assertEmailAvailable, adminResetStorePassword } from "./userService.js";
import { AppError, assertStrongPassword, pick } from "../utils/validate.js";

const EDITABLE = ["storeName", "location", "email", "cinNo", "gstNo", "state", "city", "address", "phone", "termsConditions", "tagline"];

const normalise = (data) => {
  const out = pick(data, EDITABLE);
  for (const k of Object.keys(out)) out[k] = typeof out[k] === "string" ? out[k].trim() || null : out[k];
  if (out.state) out.state = out.state.toUpperCase();
  if (out.gstNo) out.gstNo = out.gstNo.toUpperCase();
  return out;
};

export const createStore = async (data) => {
  const storeName = String(data?.storeName || "").trim();
  if (!storeName) throw new AppError("Store name is required.");
  const email = await assertEmailAvailable(data?.email);
  assertStrongPassword(data?.password);
  return createStoreRepo({
    ...normalise(data),
    storeName,
    email,
    password: await bcrypt.hash(data.password, 10),
    role: "STORE",
    mustChangePassword: true,
  });
};

export const getAllStores = () => getAllStoresRepo();
/** Picker list. Registration details (GSTIN/CIN) are shown only for the caller's own store
 * unless the caller is an admin (SEC31-14). */
export const getStoreOptions = async (user = null) => {
  const rows = await getStoreOptionsRepo();
  if (user?.role === "ADMIN") return rows;
  const own = Number(user?.storeId);
  return rows.map((r) => (r.id === own ? r : { id: r.id, storeName: r.storeName, location: r.location, city: r.city, state: r.state }));
};

export const getStoreById = async (id) => {
  const store = await getStoreByIdRepo(id);
  if (!store) throw new AppError("Store not found", 404);
  return store;
};

/** Only profile fields can be edited here. Passwords use resetStorePassword; role can never change. */
export const updateStore = async (id, data) => {
  await getStoreById(id);
  const update = normalise(data);
  if (update.email) update.email = await assertEmailAvailable(update.email, { excludeStoreId: Number(id) });
  if (update.storeName === null) throw new AppError("Store name is required.");
  return updateStoreRepo(id, update);
};

export const resetStorePassword = (id, newPassword) => adminResetStorePassword(id, newPassword);

export const deleteStore = async (id) => {
  await getStoreById(id);
  try {
    return await deleteStoreRepo(id);
  } catch (err) {
    if (err?.code === "P2003") throw new AppError("This store has stock, sales or other records and cannot be deleted.", 409);
    throw err;
  }
};
