import { stripSensitive } from "../utils/publicSelect.js";

/** Minimal security headers (helmet-equivalent defaults that are safe for a JSON API). */
export const securityHeaders = (req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
};

/** Defence in depth: strip credential fields from every JSON response. */
export const sanitizeResponses = (req, res, next) => {
  const original = res.json.bind(res);
  res.json = (body) => original(stripSensitive(body));
  next();
};

/** Small in-memory fixed-window rate limiter (per process). */
export const rateLimit = ({ windowMs = 15 * 60 * 1000, max = 10, key = (req) => req.ip, message = "Too many attempts. Please try again later." } = {}) => {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k); }, Math.min(windowMs, 60_000)).unref();
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let rec = hits.get(k);
    if (!rec || rec.resetAt <= now) { rec = { count: 0, resetAt: now + windowMs }; hits.set(k, rec); }
    rec.count += 1;
    if (rec.count > max) {
      res.setHeader("Retry-After", Math.ceil((rec.resetAt - now) / 1000));
      return res.status(429).json({ success: false, message });
    }
    return next();
  };
};
