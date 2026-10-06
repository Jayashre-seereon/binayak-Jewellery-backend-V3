import * as service from "../services/partyOpeningBalanceService.js";
import { safeMessage } from "../middleware/errorHandler.js";

// Existing clients read `error`; `message`/`success` are added for the common envelope.
const fail = (res, err, fallbackStatus = 400) => {
  const message = safeMessage(err);
  return res.status(err?.status || fallbackStatus).json({ success: false, error: message, message });
};

// CREATE
export const createPartyOpeningBalance = async (req, res) => {
  try {
    const data = await service.createPartyOpeningBalanceService(req.body, Number(req.query.storeId));
    res.json(data);
  } catch (err) {
    fail(res, err);
  }
};

// GET
export const getPartyOpeningBalances = async (req, res) => {
  try {
    const data = await service.getPartyOpeningBalancesService(Number(req.query.storeId));
    res.json(data);
  } catch (err) {
    fail(res, err, 500);
  }
};

// GET BY ID
export const getPartyOpeningBalanceById = async (req, res) => {
  try {
    const data = await service.getPartyOpeningBalanceByIdService(req.params.id, Number(req.query.storeId));
    res.json(data);
  } catch (err) {
    fail(res, err, 404);
  }
};

// UPDATE
export const updatePartyOpeningBalance = async (req, res) => {
  try {
    const data = await service.updatePartyOpeningBalanceService(req.params.id, req.body, Number(req.query.storeId));
    res.json(data);
  } catch (err) {
    fail(res, err);
  }
};

// DELETE
export const deletePartyOpeningBalance = async (req, res) => {
  try {
    await service.deletePartyOpeningBalanceService(req.params.id, Number(req.query.storeId));
    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    fail(res, err);
  }
};
