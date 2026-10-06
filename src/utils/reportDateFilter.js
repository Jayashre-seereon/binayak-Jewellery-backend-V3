// Report period → [from, to] instants, computed in shop time (IST, UTC+05:30, no DST)
// regardless of the server's timezone.
import { AppError } from "./validate.js";

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const REPORT_PERIODS = [
  { value: "TODAY", label: "Today" },
  { value: "YESTERDAY", label: "Yesterday" },
  { value: "THIS_WEEK", label: "This Week" },
  { value: "LAST_WEEK", label: "Last Week" },
  { value: "THIS_MONTH", label: "This Month" },
  { value: "LAST_MONTH", label: "Last Month" },
  { value: "THIS_QUARTER", label: "This Quarter" },
  { value: "LAST_QUARTER", label: "Last Quarter" },
  { value: "THIS_YEAR", label: "This Year" },
  { value: "LAST_YEAR", label: "Last Year" },
  { value: "ALL", label: "All Time" },
  { value: "CUSTOM", label: "Custom Range" },
];
const PERIOD_SET = new Set(REPORT_PERIODS.map((p) => p.value));

/** IST calendar parts of an instant. */
const istParts = (date = new Date()) => {
  const d = new Date(date.getTime() + IST_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay() };
};
/** Instant of IST midnight for the given calendar day (month/day may overflow, like new Date()). */
const istMidnight = (y, m, d) => new Date(Date.UTC(y, m, d) - IST_OFFSET_MS);
const istEndOfDay = (y, m, d) => new Date(istMidnight(y, m, d + 1).getTime() - 1);

/** Parses "YYYY-MM-DD" (or any Date-parsable value) to IST calendar parts. */
export const parseReportDate = (value, field = "Date") => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new AppError(`${field} is not a valid date.`);
    return istParts(value);
  }
  const s = String(value ?? "").trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const check = new Date(Date.UTC(y, mo, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo || check.getUTCDate() !== d) {
      throw new AppError(`${field} is not a valid date.`);
    }
    return { y, m: mo, d };
  }
  const t = new Date(s);
  if (!s || Number.isNaN(t.getTime())) throw new AppError(`${field} is not a valid date.`);
  return istParts(t);
};

export const getReportDateRange = (period = "THIS_MONTH", fromDate, toDate, now = new Date()) => {
  const p = String(period || "THIS_MONTH").toUpperCase();
  const t = istParts(now);
  let from;
  let to;

  switch (p) {
    case "TODAY":
      from = istMidnight(t.y, t.m, t.d);
      to = istEndOfDay(t.y, t.m, t.d);
      break;
    case "YESTERDAY":
      from = istMidnight(t.y, t.m, t.d - 1);
      to = istEndOfDay(t.y, t.m, t.d - 1);
      break;
    case "THIS_WEEK":
    case "LAST_WEEK": {
      // Weeks run Monday → Sunday.
      const back = t.dow === 0 ? 6 : t.dow - 1;
      const start = t.d - back - (p === "LAST_WEEK" ? 7 : 0);
      from = istMidnight(t.y, t.m, start);
      to = istEndOfDay(t.y, t.m, start + 6);
      break;
    }
    case "LAST_MONTH":
      from = istMidnight(t.y, t.m - 1, 1);
      to = istEndOfDay(t.y, t.m, 0);
      break;
    case "THIS_QUARTER":
    case "LAST_QUARTER": {
      const q = Math.floor(t.m / 3) * 3 - (p === "LAST_QUARTER" ? 3 : 0);
      from = istMidnight(t.y, q, 1);
      to = istEndOfDay(t.y, q + 3, 0);
      break;
    }
    case "THIS_YEAR":
      from = istMidnight(t.y, 0, 1);
      to = istEndOfDay(t.y, 11, 31);
      break;
    case "LAST_YEAR":
      from = istMidnight(t.y - 1, 0, 1);
      to = istEndOfDay(t.y - 1, 11, 31);
      break;
    case "ALL":
      from = istMidnight(2000, 0, 1);
      to = istEndOfDay(2099, 11, 31);
      break;
    case "CUSTOM": {
      if (!fromDate || !toDate) throw new AppError("Please select both From Date and To Date.");
      const f = parseReportDate(fromDate, "From Date");
      const e = parseReportDate(toDate, "To Date");
      from = istMidnight(f.y, f.m, f.d);
      to = istEndOfDay(e.y, e.m, e.d);
      if (from > to) throw new AppError("From Date cannot be greater than To Date.");
      break;
    }
    case "THIS_MONTH":
    default:
      from = istMidnight(t.y, t.m, 1);
      to = istEndOfDay(t.y, t.m + 1, 0);
      break;
  }

  return { fromDate: from, toDate: to };
};

/** Validated period code (unknown codes → 400 instead of silently meaning "this month"). */
export const normalisePeriod = (period, fallback = "THIS_MONTH") => {
  if (period === undefined || period === null || period === "") return fallback;
  const p = String(period).toUpperCase();
  if (!PERIOD_SET.has(p)) throw new AppError(`Unknown report period "${period}".`);
  return p;
};

export const periodName = (period) => REPORT_PERIODS.find((p) => p.value === period)?.label || String(period || "");

export { DAY_MS, IST_OFFSET_MS };
