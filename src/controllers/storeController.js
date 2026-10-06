import { safeMessage } from "../middleware/errorHandler.js";
import { createStore, getAllStores, getStoreById, updateStore, deleteStore, resetStorePassword, getStoreOptions } from "../services/storeService.js";

// Never echo raw error text (Prisma messages carry query/schema details) — SEC31-09.
const fail = (res, err, fallback = 400) => {
  const status = Number(err?.status) || fallback;
  if (status >= 500) console.error(err);
  return res.status(status).json({ success: false, message: status >= 500 ? "Something went wrong. Please try again." : safeMessage(err, "Request could not be completed.") });
};
const id = (req) => Number(req.params.id);

export const createStoreController = async (req, res) => {
  try { res.status(201).json({ success: true, store: await createStore(req.body) }); } catch (err) { fail(res, err); }
};
export const getAllStoresController = async (req, res) => {
  try { res.json({ success: true, stores: await getAllStores() }); } catch (err) { fail(res, err, 500); }
};
export const getStoreOptionsController = async (req, res) => {
  try { res.json({ success: true, data: await getStoreOptions(req.user) }); } catch (err) { fail(res, err, 500); }
};
export const getStoreByIdController = async (req, res) => {
  try { res.json({ success: true, store: await getStoreById(id(req)) }); } catch (err) { fail(res, err, 404); }
};
export const updateStoreController = async (req, res) => {
  try { res.json({ success: true, message: "Store updated", store: await updateStore(id(req), req.body) }); } catch (err) { fail(res, err); }
};
export const resetStorePasswordController = async (req, res) => {
  try { res.json(await resetStorePassword(id(req), req.body?.newPassword ?? req.body?.password)); } catch (err) { fail(res, err); }
};
export const deleteStoreController = async (req, res) => {
  try { await deleteStore(id(req)); res.json({ success: true, message: "Store deleted" }); } catch (err) { fail(res, err); }
};
