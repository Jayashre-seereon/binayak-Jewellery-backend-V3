import * as partytypeService from "../services/partytypeService.js";
import { sendError } from "../utils/errorHandler.js";

// CREATE
export const createPartyType = async (req, res) => {
  try {
    const partytype = await partytypeService.createPartyType(req.body || {}, Number(req.query.storeId));
    res.status(201).json({ success: true, partytype });
  } catch (err) {
    sendError(res, err, "Could not create party type.");
  }
};

// GET ALL
export const getPartyTypes = async (req, res) => {
  try {
    const partytypes = await partytypeService.getPartyTypes(Number(req.query.storeId));
    res.json({ success: true, partytypes });
  } catch (err) {
    sendError(res, err, "Could not load party type.");
  }
};

// GET BY ID
export const getPartyTypeById = async (req, res) => {
  try {
    const partytype = await partytypeService.getPartyTypeById(req.params.id, Number(req.query.storeId));
    res.json({ success: true, partytype });
  } catch (err) {
    sendError(res, err, "Could not load party type.");
  }
};

// UPDATE
export const updatePartyType = async (req, res) => {
  try {
    const partytype = await partytypeService.updatePartyType(req.params.id, req.body || {}, Number(req.query.storeId));
    res.json({ success: true, partytype });
  } catch (err) {
    sendError(res, err, "Could not update party type.");
  }
};

// DELETE
export const deletePartyType = async (req, res) => {
  try {
    await partytypeService.deletePartyType(req.params.id, Number(req.query.storeId));
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    sendError(res, err, "Could not delete party type.");
  }
};
