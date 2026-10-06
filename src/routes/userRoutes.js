import express from "express";
import { signup, login, forgot, reset, logout, refreshToken, changePasswordController } from "../controllers/userController.js";
import { authMiddleware, requireRole } from "../middleware/authMiddleware.js";
import { rateLimit } from "../middleware/security.js";

const router = express.Router();
// Per-account limits key on the email exactly as the account lookup normalises it (trim +
// lowercase), independent of the client IP; a separate per-IP limit stops spraying (SEC31-02).
const emailKey = (req) => `acct|${String(req.body?.email || "").trim().toLowerCase()}`;
const ipKey = (req) => `ip|${req.ip}`;
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: Number(process.env.LOGIN_MAX_ATTEMPTS || 10), key: emailKey, message: "Too many login attempts. Please wait 15 minutes and try again." });
const loginIpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: Number(process.env.LOGIN_MAX_PER_IP || 50), key: ipKey, message: "Too many login attempts from this network. Please wait 15 minutes and try again." });
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, key: emailKey });
const resetIpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, key: ipKey });
export const refreshLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, key: ipKey });

// Public signup creates an ADMIN account; signupUser ignores any caller-supplied role.
router.post("/signup", signup);
router.post("/refresh-token", refreshLimiter, refreshToken);
router.post("/login", loginIpLimiter, loginLimiter, login);
router.post("/logout", authMiddleware, logout);
router.post("/change-password", authMiddleware, changePasswordController);
router.post("/forgot", resetIpLimiter, resetLimiter, forgot);
router.post("/reset", resetIpLimiter, resetLimiter, reset);

export default router;
