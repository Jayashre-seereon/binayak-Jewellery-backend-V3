/** JSON 404 for unknown API routes. */
export const notFound = (req, res) => res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl.split("?")[0]}` });

const PRISMA_MESSAGES = {
  P2002: (e) => `A record with this ${(e.meta?.target || []).toString().replace(/storeId,?/, "").replace(/_/g, " ") || "value"} already exists.`,
  P2003: () => "This record is linked with other data and cannot be changed or deleted.",
  P2025: () => "Record not found.",
};

/** Final error handler: never leaks stack traces or internal query details. */
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return;
  if (err?.type === "entity.parse.failed") return res.status(400).json({ success: false, message: "Invalid JSON in request body." });
  if (err?.type === "entity.too.large") return res.status(413).json({ success: false, message: "Request body is too large." });
  if (err?.name === "MulterError") return res.status(400).json({ success: false, message: `Upload error: ${err.message}` });
  if (err?.code && PRISMA_MESSAGES[err.code]) {
    return res.status(err.code === "P2025" ? 404 : 409).json({ success: false, message: PRISMA_MESSAGES[err.code](err) });
  }
  const inputError = err?.name === "PrismaClientValidationError" || /value out of range|integer out of range|out of range for type/i.test(String(err?.message || ""));
  if (inputError) return res.status(400).json({ success: false, message: "Invalid request parameters." });
  const status = Number(err?.status || err?.statusCode) || 500;
  if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  return res.status(status).json({ success: false, message: status >= 500 ? "Something went wrong. Please try again." : err.message });
};

/** Turns raw Prisma/internal error text into a user-safe message for controllers that do res.status(400).json({message: err.message}). */
export const safeMessage = (err, fallback = "Request could not be completed.") => {
  if (!err) return fallback;
  if (err.code && PRISMA_MESSAGES[err.code]) return PRISMA_MESSAGES[err.code](err);
  const msg = String(err.message || "");
  if (/Invalid `.*` invocation|prisma\.|Argument `|PrismaClient|out of range|violates|relation "|column "/i.test(msg)) return fallback;
  return msg || fallback;
};
