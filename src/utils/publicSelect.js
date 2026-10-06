// Store fields that are safe to send to clients (never password / refreshToken / resetToken).
export const publicStoreSelect = {
  id: true,
  storeName: true,
  location: true,
  email: true,
  role: true,
  cinNo: true,
  gstNo: true,
  state: true,
  city: true,
  address: true,
  phone: true,
  termsConditions: true,
  tagline: true,
  mustChangePassword: true,
  createdAt: true,
  updatedAt: true,
};

export const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  mustChangePassword: true,
  createdAt: true,
  updatedAt: true,
};

const SENSITIVE_KEYS = new Set(["password", "refreshToken", "resetToken", "resetTokenExpiry"]);

/** Recursively removes credential fields from any object graph (defence in depth for API responses). */
export const stripSensitive = (value, seen = new WeakSet()) => {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = stripSensitive(value[i], seen);
    return value;
  }
  // Only database-record-shaped objects (they carry an `id`) are scrubbed, so an auth
  // response like { accessToken, refreshToken, user } is left intact.
  const isRecord = Object.prototype.hasOwnProperty.call(value, "id");
  for (const key of Object.keys(value)) {
    if (isRecord && SENSITIVE_KEYS.has(key)) delete value[key];
    else value[key] = stripSensitive(value[key], seen);
  }
  return value;
};
