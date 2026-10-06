// Barcode value rules and rendering shared by the barcode module, item master and stock entry.
import bwipjs from "bwip-js";
import { AppError } from "../../utils/validate.js";

export const SYMBOLOGIES = ["CODE128", "EAN13", "QRCODE"];
const BWIP_ID = { CODE128: "code128", EAN13: "ean13", QRCODE: "qrcode" };

/** EAN-13 check digit for the first 12 digits (weights 1,3,1,3… from the left). */
export const ean13CheckDigit = (twelve) => {
  const digits = String(twelve);
  if (!/^\d{12}$/.test(digits)) throw new AppError("EAN-13 needs exactly 12 data digits.");
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
};

export const isValidEan13 = (code) => /^\d{13}$/.test(String(code)) && ean13CheckDigit(String(code).slice(0, 12)) === String(code)[12];

/**
 * Validates a barcode typed or scanned in by a user (item code, or a piece's existing tag).
 *  - 13 digits → must be a valid EAN-13 (checksum verified) — catches mistyped digits.
 *  - otherwise printable ASCII without spaces, 4–48 chars (Code 128 can encode all of it).
 * Returns the normalised value.
 */
export const validateBarcodeValue = (value) => {
  const code = String(value ?? "").trim();
  if (!code) throw new AppError("Barcode is required.");
  if (/^\d{13}$/.test(code)) {
    if (!isValidEan13(code)) {
      throw new AppError(`"${code}" is not a valid EAN-13 barcode (check digit should be ${ean13CheckDigit(code.slice(0, 12))}).`);
    }
    return code;
  }
  if (code.length < 4 || code.length > 48) throw new AppError("Barcode must be 4 to 48 characters long.");
  if (!/^[\x21-\x7E]+$/.test(code)) throw new AppError("Barcode may contain only printable characters (letters, digits, symbols) and no spaces.");
  return code;
};

/**
 * Store-range EAN-13 item code: prefix (2 digits, 20–29 are reserved for in-store use by
 * GS1) + storeId (3) + itemId (7) + check digit.
 */
export const buildItemEan13 = (prefix, storeId, itemId) => {
  const p = String(prefix ?? "29");
  if (!/^\d{2}$/.test(p)) throw new AppError("Item code prefix must be 2 digits (20–29).");
  if (Number(storeId) > 999) throw new AppError("Store id is too large for the EAN-13 layout.");
  if (Number(itemId) > 9_999_999) throw new AppError("Item id is too large for the EAN-13 layout.");
  const body = `${p}${String(storeId).padStart(3, "0")}${String(itemId).padStart(7, "0")}`;
  return body + ean13CheckDigit(body);
};

/**
 * Picks a symbology that can encode the value. "AUTO" (or EAN13) uses EAN-13 only for
 * valid EAN-13 numbers and falls back to Code 128 for everything else.
 */
export const pickSymbology = (code, preferred = "AUTO") => {
  const want = String(preferred || "AUTO").toUpperCase();
  if (want === "QRCODE") return "QRCODE";
  if (want === "CODE128") return "CODE128";
  return isValidEan13(code) ? "EAN13" : "CODE128";
};

const clamp = (v, min, max, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

/**
 * Renders a barcode as PNG. `height` is the bar height in mm (bwip-js units), scale is
 * the pixel multiplier. Values are clamped so a request cannot ask for a huge image.
 */
export const renderBarcodePng = async (code, { symbology = "CODE128", scale = 3, height = 12, includeText = true } = {}) => {
  const text = String(code ?? "");
  const sym = String(symbology || "CODE128").toUpperCase();
  if (!SYMBOLOGIES.includes(sym)) throw new AppError(`Symbology must be one of ${SYMBOLOGIES.join(", ")}.`);
  if (!text) throw new AppError("Barcode text is required.");
  if (sym === "QRCODE" ? text.length > 512 : text.length > 80) throw new AppError("Barcode text is too long for this symbology.");
  if (sym === "EAN13" && !isValidEan13(text)) throw new AppError(`"${text}" is not a valid EAN-13 barcode.`);
  if (sym === "CODE128" && !/^[\x20-\x7E]+$/.test(text)) throw new AppError("Code 128 supports printable ASCII characters only.");

  const opts = {
    bcid: BWIP_ID[sym],
    text,
    scale: Math.round(clamp(scale, 1, 8, 3)),
    paddingwidth: 4,
    paddingheight: 2,
    backgroundcolor: "FFFFFF",
  };
  if (sym === "QRCODE") {
    opts.eclevel = "M";
  } else {
    opts.height = clamp(height, 4, 40, 12);
    if (includeText) {
      opts.includetext = true;
      opts.textxalign = "center";
      opts.textsize = 9;
    }
  }
  try {
    return await bwipjs.toBuffer(opts);
  } catch (err) {
    throw new AppError(`Cannot render "${text}" as ${sym}: ${String(err?.message || err).replace(/^bwipp\.\w+#?\d*:\s*/i, "")}`);
  }
};
