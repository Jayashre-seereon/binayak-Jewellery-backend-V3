// Formatting helpers shared by every printed document (invoices, vouchers, labels).
// Indian number grouping, IST dates, and "print '-' when missing" semantics.

const IST = "Asia/Kolkata";

const moneyFormatter = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const weightFormatter = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const rateFormatter = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 3 });

export const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export const round2 = (value) => Math.round((num(value) + Number.EPSILON) * 100) / 100;

/** 1,23,456.78 (Indian grouping). Negative zero prints as 0.00. */
export const inr = (value) => {
  const n = round2(value);
  return moneyFormatter.format(Object.is(n, -0) || Math.abs(n) < 0.005 ? 0 : n);
};

export const weight = (value) => weightFormatter.format(num(value));

export const rateText = (value) => rateFormatter.format(num(value));

// Values that are clearly placeholders in master data are treated as missing.
const PLACEHOLDER = /^(?:-+|x+|n\/?a|nil|null|undefined|none|\.+)$/i;

/** Trimmed string, or "" when the value is empty / a placeholder. */
export const clean = (value) => {
  if (value === null || value === undefined) return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  return PLACEHOLDER.test(text) ? "" : text;
};

/** Printable value: the cleaned text or "-". */
export const dash = (value) => clean(value) || "-";

export const upper = (value) => clean(value).toUpperCase();

const datePart = new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "2-digit", month: "short", year: "numeric" });
const timePart = new Intl.DateTimeFormat("en-IN", { timeZone: IST, hour: "2-digit", minute: "2-digit", hour12: true });

const toDate = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const istDate = (value) => {
  const d = toDate(value);
  return d ? datePart.format(d) : "-";
};

/** Date-only migrated rows are stored at midnight UTC: print them without a fake time. */
export const hasTime = (value) => {
  const d = toDate(value);
  if (!d) return false;
  return !(d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0);
};

export const istTime = (value) => {
  const d = toDate(value);
  return d && hasTime(d) ? timePart.format(d).toUpperCase() : "";
};

export const istDateTime = (value) => {
  const date = istDate(value);
  const time = istTime(value);
  return time ? `${date}, ${time}` : date;
};

export const GST_STATE_CODES = {
  "JAMMU AND KASHMIR": "01", "HIMACHAL PRADESH": "02", PUNJAB: "03", CHANDIGARH: "04", UTTARAKHAND: "05",
  HARYANA: "06", DELHI: "07", RAJASTHAN: "08", "UTTAR PRADESH": "09", BIHAR: "10", SIKKIM: "11",
  "ARUNACHAL PRADESH": "12", NAGALAND: "13", MANIPUR: "14", MIZORAM: "15", TRIPURA: "16", MEGHALAYA: "17",
  ASSAM: "18", "WEST BENGAL": "19", JHARKHAND: "20", ODISHA: "21", ORISSA: "21", CHHATTISGARH: "22",
  "MADHYA PRADESH": "23", GUJARAT: "24", "DADRA AND NAGAR HAVELI AND DAMAN AND DIU": "26", MAHARASHTRA: "27",
  KARNATAKA: "29", GOA: "30", LAKSHADWEEP: "31", KERALA: "32", "TAMIL NADU": "33", PUDUCHERRY: "34",
  "ANDAMAN AND NICOBAR ISLANDS": "35", TELANGANA: "36", "ANDHRA PRADESH": "37", LADAKH: "38",
};

export const stateWithCode = (state) => {
  const name = upper(state);
  if (!name) return "-";
  const code = GST_STATE_CODES[name];
  return code ? `${name} (${code})` : name;
};

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

export const panFromGstin = (gstin) => {
  const g = upper(gstin);
  return GSTIN_RE.test(g) ? g.slice(2, 12) : "";
};

/** Masks identity numbers (Aadhaar etc.) to the last four characters. */
export const maskId = (value) => {
  const v = clean(value).replace(/\s+/g, "");
  if (!v) return "";
  if (v.length <= 4) return v;
  return `${"X".repeat(Math.min(8, v.length - 4))}${v.slice(-4)}`;
};

export const labelize = (value) => clean(value).replace(/_/g, " ");

export const titleCase = (value) =>
  labelize(value).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
