import * as service from "../services/gradeService.js";
import { sendError } from "../utils/errorHandler.js";

// Grade endpoints return the raw record/array (the grade screen unwraps it); errors use
// the shared { success:false, message, error } envelope with proper 4xx codes.

// CREATE
export const createGrade = async (req, res) => {
  try {
    const data = await service.createGradeService(req.body || {}, Number(req.query.storeId));
    res.status(201).json(data);
  } catch (err) {
    sendError(res, err, "Could not create grade.");
  }
};

// GET GRADES BY PURITY ID
export const getGradesByPurityId = async (req, res) => {
  try {
    const data = await service.getGradesByPurityIdService(req.params.purityId, Number(req.query.storeId));
    res.json(data);
  } catch (err) {
    sendError(res, err, "Could not load grades.");
  }
};

// GET
export const getGrades = async (req, res) => {
  try {
    const data = await service.getGradesService(Number(req.query.storeId));
    res.json(data);
  } catch (err) {
    sendError(res, err, "Could not load grades.");
  }
};

// GET BY ID
export const getGradeById = async (req, res) => {
  try {
    const data = await service.getGradeByIdService(req.params.id, Number(req.query.storeId));
    res.json(data);
  } catch (err) {
    sendError(res, err, "Could not load grade.");
  }
};

// UPDATE
export const updateGrade = async (req, res) => {
  try {
    const data = await service.updateGradeService(req.params.id, req.body || {}, Number(req.query.storeId));
    res.json(data);
  } catch (err) {
    sendError(res, err, "Could not update grade.");
  }
};

// DELETE
export const deleteGrade = async (req, res) => {
  try {
    await service.deleteGradeService(req.params.id, Number(req.query.storeId));
    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    sendError(res, err, "Could not delete grade.");
  }
};
