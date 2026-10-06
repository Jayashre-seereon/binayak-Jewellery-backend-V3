import { AppError, MAX_DB_INT } from "./validate.js";
import { safeMessage } from "../middleware/errorHandler.js";

/**
 * Human message for a failed delete. P2003 = a foreign key still points at the row
 * (e.g. a category used by products), which is the common "in use" case.
 */
export const handleDeleteError = (error, entity = "record") => {
  if (error?.code === "P2003" || error?.code === "P2014") {
    return `Cannot delete this ${entity} because it is in use (linked with other data). Remove or reassign the linked records first.`;
  }
  if (error?.code === "P2025") return `${entity} not found or already deleted.`;
  if (error?.expose && error.message) return error.message;
  return `Failed to delete ${entity}.`;
};

/** Re-throws a delete failure as a 409/404 AppError with a friendly message. */
export const rethrowDeleteError = (error, entity = "record") => {
  const status = error?.code === "P2025" ? 404 : error?.status || 409;
  throw new AppError(handleDeleteError(error, entity), status);
};

// Bad input that slipped past validation (e.g. an id beyond INTEGER range) is a 400, not a 500.
export const isPrismaInputError = (err) =>
  err?.name === "PrismaClientValidationError" || ["P2000", "P2006", "P2007", "P2009", "P2012", "P2019", "P2020", "P2023", "P2033"].includes(err?.code) ||
  /value out of range|integer out of range|out of range for type/i.test(String(err?.message || ""));

const prismaStatus = (err) => {
  if (err?.code === "P2002" || err?.code === "P2003") return 409;
  if (err?.code === "P2025") return 404;
  if (isPrismaInputError(err)) return 400;
  return undefined;
};

/**
 * Uniform error response for master controllers. Keeps both `message` and the
 * legacy `error` key (grade / party screens read `error`). Never leaks Prisma text.
 */
export const sendError = (res, err, fallback = "Request could not be completed.") => {
  const status = Number(err?.status || err?.statusCode) || prismaStatus(err) || 400;
  if (status >= 500) console.error("[masters]", err);
  const message = status >= 500 ? "Something went wrong. Please try again." : safeMessage(err, fallback);
  return res.status(status).json({ success: false, message, error: message });
};

/**
 * Loads a row only if it belongs to the store; otherwise 404 (never reveals that
 * the id exists in another store).
 */
export const findOwned = async (delegate, id, storeId, label = "Record", args = {}) => {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_DB_INT) throw new AppError(`Invalid ${label.toLowerCase()} id.`);
  const row = await delegate.findFirst({ where: { id: n, storeId: Number(storeId) }, ...args });
  if (!row) throw new AppError(`${label} not found.`, 404);
  return row;
};

/** Same as findOwned but for a referenced foreign key in a request body (400, not 404). */
export const assertRef = async (delegate, id, storeId, label = "Record", args = {}) => {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_DB_INT) throw new AppError(`Invalid ${label.toLowerCase()}.`);
  const row = await delegate.findFirst({ where: { id: n, storeId: Number(storeId) }, ...args });
  if (!row) throw new AppError(`${label} not found in this store.`, 400);
  return row;
};

/** Blank ("", null, 0, "0", "NONE", "null") → null; anything else must be a positive integer. */
export const blankableId = (value, field = "id") => {
  if (value === undefined) return undefined;
  if (value === null || value === "" || value === 0 || value === "0" || value === "NONE" || value === "null" || value === "undefined") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(`Invalid ${field}.`);
  return n;
};

/** True when the new name differs (case-insensitive, trimmed) from the stored one. */
export const nameChanged = (incoming, current) =>
  incoming !== undefined && String(incoming ?? "").trim().toLowerCase() !== String(current ?? "").trim().toLowerCase();
