import {
  lookupCustomerByPhoneService,
  getCustomerHistoryService,
  listCustomersService,
} from "../services/customerService.js";
import { safeMessage } from "../middleware/errorHandler.js";

// Tenant scope is enforced by authMiddleware (STORE logins are pinned to their own store);
// there is deliberately no fallback store here.
const storeIdOf = (req) => Number(req.storeId || req.query.storeId);

const fail = (res, error, fallback) => {
  const status = error?.status || 400;
  if (status >= 500) console.error(fallback, error);
  return res.status(status).json({ success: false, message: safeMessage(error, fallback) });
};

export const lookupCustomer = async (req, res) => {
  try {
    const result = await lookupCustomerByPhoneService(req.query.phone, storeIdOf(req));
    return res.json({ success: true, ...result });
  } catch (error) {
    return fail(res, error, "Failed to lookup customer.");
  }
};

export const getCustomerHistory = async (req, res) => {
  try {
    const result = await getCustomerHistoryService(req.params.id, storeIdOf(req));
    return res.json({ success: true, ...result });
  } catch (error) {
    return fail(res, error, "Failed to get customer history.");
  }
};

export const getCustomers = async (req, res) => {
  try {
    const result = await listCustomersService(storeIdOf(req), {
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return fail(res, error, "Failed to get customers.");
  }
};
