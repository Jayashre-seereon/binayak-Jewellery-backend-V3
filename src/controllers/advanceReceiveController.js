import * as advanceReceiveService from "../services/advanceReceiveService.js";
import { safeMessage } from "../middleware/errorHandler.js";

const getStoreId = (req) => Number(req.storeId || req.query.storeId);

const fail = (res, error, fallback, label) => {
  const status = error?.status || 400;
  if (!error?.status) console.error(label, error);
  return res.status(status).json({ success: false, message: safeMessage(error, fallback) });
};

/** Legacy endpoint: advances are created through Receipt Voucher only (always rejected). */
export const createAdvanceReceive = async (req, res) => {
  try {
    await advanceReceiveService.createAdvanceReceiveService(req.body, getStoreId(req));
    return res.status(400).json({ success: false, message: advanceReceiveService.RECEIPT_VOUCHER_ONLY });
  } catch (error) {
    return fail(res, error, advanceReceiveService.RECEIPT_VOUCHER_ONLY, "Create advance receive error:");
  }
};

export const getAdvanceReceives = async (req, res) => {
  try {
    const advances = await advanceReceiveService.getAdvanceReceivesService(getStoreId(req));
    return res.status(200).json({ success: true, data: advances });
  } catch (error) {
    return fail(res, error, "Unable to load advances.", "Get advance receives error:");
  }
};

export const getAdvanceReceiveById = async (req, res) => {
  try {
    const advance = await advanceReceiveService.getAdvanceReceiveByIdService(req.params.id, getStoreId(req));
    return res.status(200).json({ success: true, data: advance });
  } catch (error) {
    return fail(res, error, "Advance receive not found.", "Get advance receive error:");
  }
};

export const getAdvanceReceivesByContact = async (req, res) => {
  try {
    const contactNumber = String(req.query.contactNumber || "").trim();
    const advances = await advanceReceiveService.getAdvanceReceivesByContactService(getStoreId(req), contactNumber);
    return res.status(200).json({ success: true, data: advances });
  } catch (error) {
    return fail(res, error, "Unable to load advances.", "Get advance receives by contact error:");
  }
};

export const updateAdvanceReceive = async (req, res) => {
  try {
    const advance = await advanceReceiveService.updateAdvanceReceiveService(req.params.id, req.body, getStoreId(req));
    return res.status(200).json({ success: true, message: "Advance receive updated successfully", data: advance });
  } catch (error) {
    return fail(res, error, "Unable to update the advance.", "Update advance receive error:");
  }
};

export const deleteAdvanceReceive = async (req, res) => {
  try {
    const result = await advanceReceiveService.deleteAdvanceReceiveService(req.params.id, getStoreId(req));
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return fail(res, error, "Unable to delete the advance.", "Delete advance receive error:");
  }
};
