import * as service from "../services/partyMasterService.js";
import { sendError } from "../utils/errorHandler.js";

// Party endpoints return the raw record/array (the party screens unwrap it); errors use
// the shared { success:false, message, error } envelope with proper 4xx codes.

// CREATE
export const createPartyMaster = async (req, res) => {
  try {
    const data = await service.createPartyMasterService(req.body || {}, Number(req.query.storeId));
    res.status(201).json(data);
  } catch (err) {
    sendError(res, err, "Could not create party.");
  }
};

// GET
export const getPartyMasters = async (req, res) => {
  try {
    const data = await service.getPartyMastersService(Number(req.query.storeId));
    res.json(data);
  } catch (err) {
    sendError(res, err, "Could not load parties.");
  }
};

// GET BY ID
export const getPartyMasterById = async (req, res) => {
  try {
    const data = await service.getPartyMasterByIdService(req.params.id, Number(req.query.storeId));
    res.json(data);
  } catch (err) {
    sendError(res, err, "Could not load party.");
  }
};

// UPDATE
export const updatePartyMaster = async (req, res) => {
  try {
    const data = await service.updatePartyMasterService(req.params.id, req.body || {}, Number(req.query.storeId));
    res.json(data);
  } catch (err) {
    sendError(res, err, "Could not update party.");
  }
};

// DELETE
export const deletePartyMaster = async (req, res) => {
  try {
    await service.deletePartyMasterService(req.params.id, Number(req.query.storeId));
    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    sendError(res, err, "Could not delete party.");
  }
};
