import jwt from "jsonwebtoken";
import prisma from "../config/db.js";
import { VERIFY_OPTS } from "../utils/jwt.js";

// Account session state (token version + forced password change), cached briefly per process.
const ACCOUNT_TTL_MS = 10_000;
const accountCache = new Map(); // "ROLE:id" -> { tv, mustChange, until }
export const invalidateAccountCache = (role, id) => accountCache.delete(`${role}:${Number(id)}`);
const accountState = async (role, id) => {
  const key = `${role}:${Number(id)}`;
  const hit = accountCache.get(key);
  if (hit && hit.until > Date.now()) return hit;
  const select = { tokenVersion: true, mustChangePassword: true };
  const row = role === "STORE"
    ? await prisma.store.findUnique({ where: { id: Number(id) }, select })
    : await prisma.user.findUnique({ where: { id: Number(id) }, select });
  if (!row) return null;
  const state = { tv: Number(row.tokenVersion || 0), mustChange: Boolean(row.mustChangePassword), until: Date.now() + ACCOUNT_TTL_MS };
  accountCache.set(key, state);
  return state;
};
// While a password change is pending only these calls are allowed.
const PASSWORD_CHANGE_ALLOWED = ["/api/users/change-password", "/api/users/logout"];

const storeExistsCache = new Map(); // storeId -> expiresAt
const storeExists = async (id) => {
  const hit = storeExistsCache.get(id);
  if (hit && hit > Date.now()) return true;
  const s = await prisma.store.findUnique({ where: { id }, select: { id: true } });
  if (s) storeExistsCache.set(id, Date.now() + 60_000);
  return Boolean(s);
};

const setQueryStore = (req, storeId) => {
  const q = { ...(req.query || {}), storeId: String(storeId) };
  Object.defineProperty(req, "query", { value: q, writable: true, configurable: true, enumerable: true });
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body) && "storeId" in req.body) req.body.storeId = storeId;
};

const requestedStore = (req) => {
  const raw = req.query?.storeId ?? req.headers["x-store-id"] ?? (req.body && typeof req.body === "object" ? req.body.storeId : undefined);
  if (raw === undefined || raw === null || raw === "") return undefined;
  return Number(raw);
};

/**
 * Verifies the access token and enforces tenant isolation:
 *  - STORE logins can only ever act as their own store (any other storeId -> 403).
 *  - ADMIN logins choose a store with ?storeId= (validated to exist).
 * Downstream code reads req.query.storeId / req.storeId as before.
 */
export const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: "No token provided" });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.ACCESS_SECRET, VERIFY_OPTS);
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
  if (decoded.typ !== "access") return res.status(401).json({ success: false, message: "Invalid token type" });
  if (!["STORE", "ADMIN"].includes(decoded.role)) return res.status(403).json({ success: false, message: "Not authorized" });

  // Server-side session checks: revoked sessions and pending forced password changes.
  let state;
  try {
    state = await accountState(decoded.role, decoded.id);
  } catch (err) {
    return next(err);
  }
  if (!state || Number(decoded.tv || 0) !== state.tv) {
    return res.status(401).json({ success: false, message: "Your session has ended. Please log in again." });
  }
  if (state.mustChange && !PASSWORD_CHANGE_ALLOWED.includes(String(req.originalUrl || "").split("?")[0])) {
    return res.status(403).json({ success: false, code: "PASSWORD_CHANGE_REQUIRED", message: "Please change your password to continue." });
  }

  const requested = requestedStore(req);
  if (decoded.role === "STORE") {
    const own = Number(decoded.storeId ?? decoded.id);
    if (requested !== undefined && requested !== own) {
      return res.status(403).json({ success: false, message: "You can only access your own store's data." });
    }
    setQueryStore(req, own);
    req.storeId = own;
    req.user = { ...decoded, storeId: own };
    return next();
  }

  if (decoded.role === "ADMIN") {
    if (requested !== undefined) {
      if (!Number.isInteger(requested) || requested <= 0 || !(await storeExists(requested))) {
        return res.status(400).json({ success: false, message: "Selected store does not exist." });
      }
      setQueryStore(req, requested);
      req.storeId = requested;
    }
    req.user = { ...decoded, storeId: req.storeId ?? null };
    return next();
  }

  return res.status(403).json({ success: false, message: "Not authorized" });
};

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ success: false, message: "You do not have permission for this action." });
  }
  return next();
};

/** For store-scoped endpoints: a store must be resolved (admin must pick one). */
export const requireStore = (req, res, next) => {
  if (!req.storeId) return res.status(400).json({ success: false, message: "Please select a store." });
  return next();
};
