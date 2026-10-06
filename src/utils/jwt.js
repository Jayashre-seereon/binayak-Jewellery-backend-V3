import jwt from "jsonwebtoken";
import crypto from "node:crypto";

const ACCESS_TTL = process.env.ACCESS_TOKEN_TTL || "15m";
const REFRESH_TTL = process.env.REFRESH_TOKEN_TTL || "7d";

const claims = (account) => ({
  id: account.id,
  email: account.email,
  role: account.role,
  name: account.name || account.storeName || account.email,
  // a STORE login always acts as its own store
  storeId: account.role === "STORE" ? account.id : null,
  // session version: bumped on logout / password change / admin reset (revokes older tokens)
  tv: Number(account.tokenVersion || 0),
});

export const generateAccessToken = (account) =>
  jwt.sign({ ...claims(account), typ: "access" }, process.env.ACCESS_SECRET, { expiresIn: ACCESS_TTL, algorithm: "HS256" });

export const generateRefreshToken = (account) =>
  jwt.sign({ id: account.id, email: account.email, role: account.role, typ: "refresh", tv: Number(account.tokenVersion || 0), jti: crypto.randomUUID() },
    process.env.REFRESH_SECRET, { expiresIn: REFRESH_TTL, algorithm: "HS256" });

/** Verify options shared by every verifier: HMAC-SHA256 only (no "none"/alg confusion). */
export const VERIFY_OPTS = { algorithms: ["HS256"] };

/** Refresh/reset tokens are stored as SHA-256 hashes, never in plain text. */
export const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
