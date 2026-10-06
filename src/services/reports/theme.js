// Shared look & formatting for every report (screen JSON, PDF and Excel use the same rules).
import { existsSync, readFileSync } from "node:fs";
import { PDF_THEME } from "../pdfTemplate.js";

export const TZ = "Asia/Kolkata";

export const COLORS = {
  ...PDF_THEME,
  zebra: "#fbf8f1",
  rule: "#ebe3cf",
  groupFill: "#f4ead0",
  subtotalFill: "#faf4e4",
  totalFill: "#1f2357",
  cardFill: "#fbf8f1",
  danger: "#b42318",
  success: "#067647",
};

const fontPath = (name) => new URL(`./fonts/${name}`, import.meta.url);
const loadFont = (name) => {
  try {
    const p = fontPath(name);
    return existsSync(p) ? readFileSync(p) : null;
  } catch {
    return null;
  }
};

// Poppins (titles) + Carlito (dense tables) both carry the ₹ glyph. If the files are
// missing we fall back to the PDF core fonts and print "Rs." instead of "₹".
const FONT_FILES = {
  display: loadFont("Poppins-Bold.ttf"),
  displayMedium: loadFont("Poppins-Medium.ttf"),
  displayRegular: loadFont("Poppins-Regular.ttf"),
  body: loadFont("Carlito-Regular.ttf"),
  bodyBold: loadFont("Carlito-Bold.ttf"),
};
const CORE = {
  display: "Helvetica-Bold",
  displayMedium: "Helvetica-Bold",
  displayRegular: "Helvetica",
  body: "Helvetica",
  bodyBold: "Helvetica-Bold",
};
export const HAS_RUPEE_FONT = Boolean(FONT_FILES.body && FONT_FILES.bodyBold && FONT_FILES.display);

/** Registers the report fonts on a pdfkit document; returns the font names to use. */
export const registerFonts = (doc) => {
  const names = {};
  for (const [key, buf] of Object.entries(FONT_FILES)) {
    if (buf && HAS_RUPEE_FONT) {
      doc.registerFont(`rpt-${key}`, buf);
      names[key] = `rpt-${key}`;
    } else {
      names[key] = CORE[key];
    }
  }
  return names;
};

export const LOGO = (() => {
  try {
    return readFileSync(new URL("../../utils/logo.png", import.meta.url));
  } catch {
    return null;
  }
})();

// ---------------------------------------------------------------- number / date formatting
const num2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num3 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const num0 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

const finite = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const RUPEE = HAS_RUPEE_FONT ? "₹" : "Rs.";

/** ₹ 1,23,456.00 (Indian digit grouping). */
export const formatMoney = (v, symbol = RUPEE) => {
  const n = finite(v);
  const s = num2.format(Math.abs(n) < 0.005 ? 0 : Math.abs(n));
  return `${n < -0.004 ? "-" : ""}${symbol} ${s}`;
};
export const formatWeight = (v) => num3.format(finite(v));
export const formatNumber = (v) => num0.format(finite(v));
export const formatPercent = (v) => `${num2.format(finite(v))}%`;

const dateKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const monthKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "YYYY-MM-DD" of the instant in shop time (IST). */
export const istDateKey = (d) => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return dateKeyFmt.format(date);
};
export const istMonthKey = (d) => {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return monthKeyFmt.format(date);
};

/** "03 Oct 2026" from a YYYY-MM-DD key, a YYYY-MM key ("Oct 2026") or a Date. */
export const formatDate = (v) => {
  if (!v) return "";
  if (typeof v === "string") {
    let m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
    m = v.match(/^(\d{4})-(\d{2})$/);
    if (m) return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  }
  const key = istDateKey(v);
  return key ? formatDate(key) : String(v);
};

const dtFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: true });
export const formatDateTime = (d = new Date()) => `${formatDate(d)}, ${dtFmt.format(d).toUpperCase()} IST`;

/** Formats a cell for PDF/plain text according to the column type. */
export const formatCell = (value, type) => {
  if (value === null || value === undefined || value === "") return "";
  switch (type) {
    case "money":
      return formatMoney(value);
    case "weight":
      return formatWeight(value);
    case "number":
      return formatNumber(value);
    case "percent":
      return formatPercent(value);
    case "date":
      return formatDate(value);
    default:
      return String(value).replace(/\s+/g, " ").trim();
  }
};

export const isNumericType = (type) => type === "money" || type === "weight" || type === "number" || type === "percent";
