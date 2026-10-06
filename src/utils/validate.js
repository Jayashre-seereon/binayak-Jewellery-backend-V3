// Shared input validation helpers. Throwing an AppError returns a clean 4xx JSON response.
export class AppError extends Error {
  constructor(message, status = 400, code = undefined) {
    super(message);
    this.status = status;
    this.statusCode = status;
    this.code = code;
    this.expose = true;
  }
}

export const roundMoney = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
export const roundWeight = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 1000) / 1000;

const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/**
 * Parse a number from user input.
 * @param {*} value
 * @param {object} opts { field, min = 0, max = 1e12, required = false, int = false, defaultValue = 0 }
 */
export const toNumber = (value, opts = {}) => {
  const { field = "value", min = 0, max = 1e12, required = false, int = false, defaultValue = 0 } = opts;
  if (isBlank(value)) {
    if (required) throw new AppError(`${field} is required.`);
    return defaultValue;
  }
  const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, "").trim());
  if (!Number.isFinite(n)) throw new AppError(`${field} must be a valid number.`);
  if (int && !Number.isInteger(n)) throw new AppError(`${field} must be a whole number.`);
  if (min !== null && n < min) throw new AppError(`${field} cannot be less than ${min}.`);
  if (max !== null && n > max) throw new AppError(`${field} is too large.`);
  return n;
};

export const toMoney = (value, opts = {}) => roundMoney(toNumber(value, { max: 1e11, ...opts }));

/** Positive integer id from params/body. */
export const MAX_DB_INT = 2147483647; // PostgreSQL INTEGER

export const parseId = (value, field = "id") => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_DB_INT) throw new AppError(`Invalid ${field}.`);
  return n;
};

export const optionalId = (value, field = "id") => (isBlank(value) ? null : parseId(value, field));

/** Valid date or default; rejects garbage strings. */
export const toDate = (value, { field = "date", defaultValue = () => new Date(), allowFutureDays = 1 } = {}) => {
  if (isBlank(value)) return defaultValue ? defaultValue() : null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new AppError(`${field} is not a valid date.`);
  if (allowFutureDays !== null && d.getTime() > Date.now() + allowFutureDays * 86400000) {
    throw new AppError(`${field} cannot be in the future.`);
  }
  return d;
};

export const cleanString = (v, max = 500) => (isBlank(v) ? null : String(v).trim().slice(0, max));
export const cleanPhone = (v) => {
  if (isBlank(v)) return "";
  const digits = String(v).replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

/** Keep only whitelisted keys of an object. */
export const pick = (obj = {}, keys = []) => {
  const out = {};
  for (const k of keys) if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined) out[k] = obj[k];
  return out;
};

export const PASSWORD_RULE = "Password must be at least 8 characters and contain a letter and a number.";
export const assertStrongPassword = (pw) => {
  if (typeof pw !== "string" || pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new AppError(PASSWORD_RULE);
};

/** Case-insensitive duplicate-name guard for masters within a store. */
export const assertUniqueName = async (delegate, { storeId, name, excludeId = null, extraWhere = {}, label = "Record" }) => {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new AppError(`${label} name is required.`);
  const existing = await delegate.findFirst({
    where: {
      storeId: Number(storeId),
      name: { equals: trimmed, mode: "insensitive" },
      ...extraWhere,
      ...(excludeId ? { NOT: { id: Number(excludeId) } } : {}),
    },
    select: { id: true },
  });
  if (existing) throw new AppError(`${label} "${trimmed}" already exists in this store.`, 409);
  return trimmed;
};

/** A stored file link: blank → null; otherwise an http(s) URL of at most 1000 characters (SEC31-11). */
export const cleanUrl = (value, label = "Link") => {
  if (isBlank(value)) return null;
  const v = String(value).trim();
  if (v.length > 1000) throw new AppError(`${label} is too long.`);
  let u;
  try { u = new URL(v); } catch { throw new AppError(`${label} must be an uploaded file link.`); }
  if (!["https:", "http:"].includes(u.protocol)) throw new AppError(`${label} must be an http(s) link.`);
  return v;
};
