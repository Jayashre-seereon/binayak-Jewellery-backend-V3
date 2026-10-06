import { safeMessage } from "../middleware/errorHandler.js";
import {
  signupUser, loginUser, forgotPassword, resetPassword, logoutUser, refreshAccessToken, changePassword,
} from "../services/userService.js";

// Never echo raw error text (Prisma messages carry query/schema details) — SEC31-09.
const fail = (res, err, fallback = 400) => {
  const status = Number(err?.status) || fallback;
  if (status >= 500) console.error(err);
  return res.status(status).json({ success: false, message: status >= 500 ? "Something went wrong. Please try again." : safeMessage(err, "Request could not be completed.") });
};

export const signup = async (req, res) => {
  try { res.status(201).json({ success: true, user: await signupUser(req.body) }); } catch (err) { fail(res, err); }
};
export const login = async (req, res) => {
  try { res.json(await loginUser(req.body)); } catch (err) { fail(res, err, 401); }
};
export const forgot = async (req, res) => {
  try { res.json(await forgotPassword(req.body?.email)); } catch (err) { fail(res, err); }
};
export const reset = async (req, res) => {
  try { res.json(await resetPassword(req.body?.token, req.body?.password ?? req.body?.newPassword)); } catch (err) { fail(res, err); }
};
export const logout = async (req, res) => {
  try { res.json(await logoutUser(req.user)); } catch (err) { fail(res, err, 500); }
};
export const changePasswordController = async (req, res) => {
  try { res.json(await changePassword(req.user, req.body)); } catch (err) { fail(res, err); }
};
const handleRefreshToken = async (req, res) => {
  try { res.json({ success: true, ...(await refreshAccessToken(req.body?.refreshToken)) }); } catch (err) { fail(res, err, 401); }
};
export const refreshToken = handleRefreshToken;
export const refreshStoreToken = handleRefreshToken;
