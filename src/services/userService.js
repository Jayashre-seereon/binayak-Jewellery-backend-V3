import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import prisma from "../config/db.js";
import { findUserByEmail, findUserById, createUser, updateUser } from "../repositories/userRepository.js";
import { findStoreByEmail, findStoreById } from "../repositories/storeRepository.js";
import { generateAccessToken, generateRefreshToken, hashToken, VERIFY_OPTS } from "../utils/jwt.js";
import { invalidateAccountCache } from "../middleware/authMiddleware.js";
import { AppError, assertStrongPassword } from "../utils/validate.js";

const GENERIC_LOGIN_ERROR = "Invalid email or password";
const RESET_TTL_MIN = Number(process.env.RESET_TOKEN_TTL_MIN || 30);
const normEmail = (e) => String(e || "").trim().toLowerCase();
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password-0", 10);

const findAccountByEmail = async (email) => {
  const user = await findUserByEmail(email);
  if (user) return { ...user, _kind: "USER" };
  const store = await findStoreByEmail(email);
  if (store) return { ...store, _kind: "STORE" };
  return null;
};

const findAccount = async (role, id) => {
  if (role === "STORE") { const s = await findStoreById(id); return s ? { ...s, _kind: "STORE" } : null; }
  const u = await findUserById(id); return u ? { ...u, _kind: "USER" } : null;
};

const saveAccount = async (account, data) => {
  const select = { id: true, tokenVersion: true };
  const row = account._kind === "STORE"
    ? await prisma.store.update({ where: { id: account.id }, data, select })
    : await prisma.user.update({ where: { id: account.id }, data, select });
  invalidateAccountCache(account._kind === "STORE" ? "STORE" : account.role, account.id);
  return row;
};

/** Ends every session of the account (access tokens carry the version and stop working). */
const REVOKE = { tokenVersion: { increment: 1 }, refreshToken: null };

const issueTokens = async (account) => {
  const accessToken = generateAccessToken(account);
  const refreshToken = generateRefreshToken(account);
  await saveAccount(account, { refreshToken: hashToken(refreshToken) });
  return { accessToken, refreshToken };
};

const publicAccount = (a) => ({
  id: a.id,
  email: a.email,
  role: a.role,
  name: a.name || a.storeName || a.email,
  storeId: a.role === "STORE" ? a.id : null,
  storeName: a.storeName || null,
  storeState: a.role === "STORE" ? a.state || null : null,
  storeGstNo: a.role === "STORE" ? a.gstNo || null : null,
  mustChangePassword: Boolean(a.mustChangePassword),
});

/** Email must be unique across admin users AND stores (both log in on the same screen). */
export const assertEmailAvailable = async (email, { excludeStoreId = null, excludeUserId = null } = {}) => {
  const e = normEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new AppError("Please enter a valid email address.");
  const u = await findUserByEmail(e);
  if (u && u.id !== excludeUserId) throw new AppError("This email is already used by another account.", 409);
  const s = await findStoreByEmail(e);
  if (s && s.id !== excludeStoreId) throw new AppError("This email is already used by another account.", 409);
  return e;
};

// ================= SIGNUP (admin creates another admin) =================
export const signupUser = async (data) => {
  const name = String(data?.name || "").trim();
  if (!name) throw new AppError("Name is required.");
  const email = await assertEmailAvailable(data?.email);
  assertStrongPassword(data?.password);
  return createUser({ name, email, password: await bcrypt.hash(data.password, 10), role: "ADMIN", mustChangePassword: true });
};

// ================= LOGIN =================
export const loginUser = async ({ email, password } = {}) => {
  if (!email || !password) throw new AppError(GENERIC_LOGIN_ERROR, 401);
  const account = await findAccountByEmail(email);
  // constant-ish time: always run a bcrypt compare
  const ok = await bcrypt.compare(String(password), account?.password || DUMMY_HASH);
  if (!account || !ok) throw new AppError(GENERIC_LOGIN_ERROR, 401);
  const tokens = await issueTokens(account);
  return { user: publicAccount(account), ...tokens };
};

// ================= REFRESH (rotating) =================
export const refreshAccessToken = async (refreshToken) => {
  if (!refreshToken) throw new AppError("Refresh token required", 401);
  let decoded;
  try {
    decoded = jwt.verify(refreshToken, process.env.REFRESH_SECRET, VERIFY_OPTS);
  } catch {
    throw new AppError("Invalid or expired refresh token", 401);
  }
  if (decoded.typ !== "refresh") throw new AppError("Invalid token type", 401);
  const account = await findAccount(decoded.role, decoded.id);
  const stored = account?.refreshToken;
  const matches = stored && stored === hashToken(refreshToken) && Number(decoded.tv || 0) === Number(account.tokenVersion || 0);
  if (!account || !matches) {
    // possible token reuse after rotation: revoke every session of the account
    if (account) await saveAccount(account, REVOKE);
    throw new AppError("Session expired. Please log in again.", 401);
  }
  const tokens = await issueTokens(account);
  return { ...tokens, user: publicAccount(account) };
};

// ================= LOGOUT =================
export const logoutUser = async (user) => {
  const account = await findAccount(user.role, user.id);
  if (account) await saveAccount(account, REVOKE);
  return { success: true, message: "Logout successful" };
};

// ================= CHANGE PASSWORD (logged in) =================
export const changePassword = async (user, { currentPassword, newPassword } = {}) => {
  const account = await findAccount(user.role, user.id);
  if (!account) throw new AppError("Account not found.", 404);
  if (!(await bcrypt.compare(String(currentPassword || ""), account.password))) throw new AppError("Current password is incorrect.", 400);
  assertStrongPassword(newPassword);
  if (currentPassword === newPassword) throw new AppError("New password must be different from the current one.");
  await saveAccount(account, { password: await bcrypt.hash(newPassword, 10), mustChangePassword: false, resetToken: null, resetTokenExpiry: null, ...REVOKE });
  const fresh = await findAccount(user.role, user.id);
  const tokens = await issueTokens(fresh); // other sessions are invalidated, this one continues
  return { success: true, message: "Password changed successfully.", user: publicAccount(fresh), ...tokens };
};

// ================= FORGOT / RESET =================
export const forgotPassword = async (email) => {
  const generic = { success: true, message: "If the account exists, reset instructions have been sent." };
  const account = await findAccountByEmail(email);
  if (!account) return generic;
  const token = crypto.randomBytes(32).toString("hex");
  await saveAccount(account, { resetToken: hashToken(token), resetTokenExpiry: new Date(Date.now() + RESET_TTL_MIN * 60000) });
  // No mail server is configured in this deployment: the link is written to the server log for the
  // administrator (never returned to the caller). Wire an SMTP/SES sender here when available.
  // Explicit opt-in only (SEC31-16): a live reset token in a log is a credential.
  if (process.env.LOG_RESET_LINKS === "true") {
    console.info(`[password-reset] ${account.email}: ${process.env.APP_URL || ""}/reset-password?token=${token}`);
  }
  return generic;
};

export const resetPassword = async (token, newPassword) => {
  if (!token) throw new AppError("Invalid or expired reset link.");
  assertStrongPassword(newPassword);
  const h = hashToken(token);
  const now = new Date();
  const user = await prisma.user.findFirst({ where: { resetToken: h, resetTokenExpiry: { gt: now } } });
  const store = user ? null : await prisma.store.findFirst({ where: { resetToken: h, resetTokenExpiry: { gt: now } } });
  const account = user ? { ...user, _kind: "USER" } : store ? { ...store, _kind: "STORE" } : null;
  if (!account) throw new AppError("Invalid or expired reset link.");
  await saveAccount(account, { password: await bcrypt.hash(newPassword, 10), resetToken: null, resetTokenExpiry: null, mustChangePassword: false, ...REVOKE });
  return { success: true, message: "Password reset successful. Please log in." };
};

// ================= ADMIN: reset a store's password =================
export const adminResetStorePassword = async (storeId, newPassword) => {
  const store = await findStoreById(storeId);
  if (!store) throw new AppError("Store not found.", 404);
  assertStrongPassword(newPassword);
  await prisma.store.update({ where: { id: store.id }, data: { password: await bcrypt.hash(newPassword, 10), mustChangePassword: true, ...REVOKE } });
  invalidateAccountCache("STORE", store.id);
  return { success: true, message: `Password reset for ${store.storeName}. The store must change it at next login.` };
};

export { updateUser };
