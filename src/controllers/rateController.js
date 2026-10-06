import * as service from "../services/rateService.js";
import { safeMessage } from "../middleware/errorHandler.js";

// Existing clients read `error`; `message`/`success` are added for the common envelope.
const fail = (res, err, fallbackStatus = 400) => {
  const message = safeMessage(err);
  return res.status(err?.status || fallbackStatus).json({ success: false, error: message, message });
};

// CREATE
export const createRate = async (req, res) => {
  try {
    const rate = await service.createRateService(req.body, Number(req.query.storeId));
    res.status(201).json(rate);
  } catch (error) {
    fail(res, error);
  }
};

// GET
export const getRates = async (req, res) => {
  try {
    const rates = await service.getRatesService(Number(req.query.storeId), {
      latest: ["1", "true"].includes(String(req.query.latest || "").toLowerCase()),
      asOf: req.query.asOf,
    });
    res.json(rates);
  } catch (error) {
    fail(res, error, 500);
  }
};

// GET BY ID
export const getRateById = async (req, res) => {
  try {
    const rate = await service.getRateByIdService(req.params.id, Number(req.query.storeId));
    res.json(rate);
  } catch (error) {
    fail(res, error, 404);
  }
};

// UPDATE
export const updateRate = async (req, res) => {
  try {
    const rate = await service.updateRateService(req.params.id, req.body, Number(req.query.storeId));
    res.json(rate);
  } catch (error) {
    fail(res, error);
  }
};

// DELETE
export const deleteRate = async (req, res) => {
  try {
    await service.deleteRateService(req.params.id, Number(req.query.storeId));
    res.json({ success: true, message: "Rate deleted successfully" });
  } catch (error) {
    fail(res, error);
  }
};
