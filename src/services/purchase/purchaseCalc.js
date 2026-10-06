// Server-side purchase valuation (PUR-03 / PUR-10 / PUR-14 / PUR-16). Client-computed totals
// and taxes are never trusted: everything payable is derived from weights, rates and charges.
import { AppError, toNumber, toMoney, roundMoney, roundWeight, cleanString, cleanUrl, optionalId, toDate } from "../../utils/validate.js";

export const PURCHASE_TYPES = ["ORNAMENT", "OLD", "BULLION"];
export const DEFAULT_STORE_STATE = "ODISHA";
export const GST_RATE = { CGST: 1.5, SGST: 1.5, IGST: 3 };

const has = (obj, key) => obj && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;

const optionalNumber = (value, opts) => {
  if (value === undefined || value === null || value === "") return null;
  return toNumber(value, opts);
};

const normaliseState = (s) => String(s || "").toUpperCase().replace(/[^A-Z]/g, "");

/** true when the place of supply is a different state from the store (IGST applies). */
export const isInterState = (placeOfSupply, storeState) => {
  const pos = normaliseState(placeOfSupply);
  if (!pos) return false;
  const own = normaliseState(storeState) || DEFAULT_STORE_STATE;
  return !(pos === own || pos.includes(own) || own.includes(pos));
};

export const assertPurchaseType = (value) => {
  const t = String(value || "").trim().toUpperCase();
  if (!t) throw new AppError("Please select a purchase type.");
  if (!PURCHASE_TYPES.includes(t)) throw new AppError("Please choose a valid purchase type (ORNAMENT, OLD or BULLION).");
  return t;
};

/** Validates one purchase line and computes its weights and amounts. */
export const buildPurchaseItem = (item, index) => {
  if (!item || typeof item !== "object") throw new AppError(`Row ${index + 1}: invalid item.`);
  const f = (name) => `Row ${index + 1}: ${name}`;

  const grossWeight = roundWeight(toNumber(item.grossWeight, { field: f("gross weight"), required: true, max: 1e6 }));
  if (grossWeight <= 0) throw new AppError(`${f("gross weight")} must be greater than zero.`);
  const stoneWeight = roundWeight(toNumber(item.stoneWeight, { field: f("stone weight"), max: 1e6 }));
  if (stoneWeight > grossWeight) throw new AppError(`${f("stone weight")} cannot be more than the gross weight.`);
  const netWeight = roundWeight(grossWeight - stoneWeight);

  const touchPercentage = optionalNumber(item.touchPercentage, { field: f("touch %"), max: 100 });
  const purity = optionalNumber(item.purity, { field: f("purity"), max: 1000 });
  const fineness = optionalNumber(item.fineness, { field: f("fineness"), max: 1000 });

  let pureWeight;
  if (touchPercentage !== null && touchPercentage > 0) {
    pureWeight = roundWeight((netWeight * touchPercentage) / 100);
  } else {
    pureWeight = roundWeight(toNumber(item.pureWeight, { field: f("pure weight"), max: 1e6 }));
    if (pureWeight > netWeight) throw new AppError(`${f("pure weight")} cannot be more than the net weight.`);
  }

  const rate = toMoney(item.rate, { field: f("rate"), max: 1e7 });
  const makingCharges = toMoney(item.makingCharges, { field: f("making charges") });
  const hallmarkCharges = toMoney(item.hallmarkCharges, { field: f("hallmark charges") });
  const stoneAmount = toMoney(item.stoneAmount, { field: f("stone amount") });
  const otherAmount = toMoney(item.otherAmount, { field: f("other amount") });
  const discount = toMoney(item.discount, { field: f("discount") });
  const wastagePercentage = toNumber(item.wastagePercentage, { field: f("wastage %"), max: 100 });

  const metalAmount = roundMoney(netWeight * rate);
  const totalAmount = roundMoney(metalAmount + makingCharges + hallmarkCharges + stoneAmount + otherAmount - discount);
  if (totalAmount < 0) throw new AppError(`${f("discount")} cannot be more than the line value.`);

  return {
    itemId: optionalId(item.itemId, "item"),
    productId: optionalId(item.productId, "product"),
    metalId: optionalId(item.metalId, "metal"),
    purityId: optionalId(item.purityId, "purity"),
    gradeId: optionalId(item.gradeId, "grade"),
    stoneId: optionalId(item.stoneId, "stone"),

    pieces: toNumber(item.pieces, { field: f("pieces"), int: true, min: 1, max: 100000, defaultValue: 1 }),

    grossWeight,
    stoneWeight,
    netWeight,
    dustWeight: roundWeight(toNumber(item.dustWeight, { field: f("dust weight"), max: 1e6 })),
    deductionWeight: roundWeight(toNumber(item.deductionWeight, { field: f("deduction weight"), max: 1e6 })),
    pureWeight,
    actualWeight: roundWeight(toNumber(item.actualWeight, { field: f("actual weight"), max: 1e6 })),
    balanceWeight: roundWeight(toNumber(item.balanceWeight, { field: f("balance weight"), max: 1e6 })),

    purity,
    touchPercentage,
    fineness,

    rate,
    makingCharges,
    wastagePercentage,
    hallmarkCharges,

    metalAmount,
    stoneAmount,
    otherAmount,
    discount,
    totalAmount,

    huidNo: cleanString(item.huidNo, 50),
    hsnCode: cleanString(item.hsnCode, 20) || "711319",
    barSerialNo: cleanString(item.barSerialNo, 100),
    assayCertNo: cleanString(item.assayCertNo, 100),
    vatType: cleanString(item.vatType, 50),
    narration: cleanString(item.narration, 1000),
    itemPhoto: cleanUrl(item.itemPhoto, `Row ${index + 1}: photo`),
    extraDetails: item.extraDetails && typeof item.extraDetails === "object" ? item.extraDetails : undefined,
  };
};

/**
 * Header totals. Tax: ORNAMENT/BULLION 3% GST by default, OLD (URD) 0% by default; `applyGst`
 * overrides the default. Intra-state CGST 1.5 + SGST 1.5, inter-state IGST 3. Under RCM the tax
 * is recorded but not added to what is payable to the seller.
 */
export const computePurchaseTotals = ({ items, purchaseType, discount: rawDiscount, applyGst, isRCM, placeOfSupply, storeState, roundOff: rawRoundOff }) => {
  const grossAmount = roundMoney(items.reduce((s, it) => s + it.totalAmount, 0));
  const discount = toMoney(rawDiscount, { field: "Discount" });
  if (discount > grossAmount + 0.001) throw new AppError("Discount cannot be more than the purchase value.");
  const taxableAmount = roundMoney(grossAmount - discount);

  const taxApplies = applyGst === undefined || applyGst === null || applyGst === "" ? purchaseType !== "OLD" : ["true", "1", "yes"].includes(String(applyGst).toLowerCase());
  const inter = isInterState(placeOfSupply, storeState);
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  if (taxApplies && taxableAmount > 0) {
    if (inter) igst = roundMoney((taxableAmount * GST_RATE.IGST) / 100);
    else {
      cgst = roundMoney((taxableAmount * GST_RATE.CGST) / 100);
      sgst = roundMoney((taxableAmount * GST_RATE.SGST) / 100);
    }
  }
  const taxAmount = roundMoney(cgst + sgst + igst);
  const rcm = Boolean(isRCM) && taxAmount > 0;
  const subtotal = roundMoney(taxableAmount + (rcm ? 0 : taxAmount));

  let roundOff;
  if (rawRoundOff === undefined || rawRoundOff === null || rawRoundOff === "") {
    roundOff = roundMoney(Math.round(subtotal) - subtotal);
  } else {
    roundOff = roundMoney(toNumber(rawRoundOff, { field: "Round off", min: null, max: null }));
    if (Math.abs(roundOff) >= 1) throw new AppError("Round off must be between -1 and 1.");
  }
  const netPayable = roundMoney(subtotal + roundOff);
  if (netPayable < 0) throw new AppError("Net payable cannot be negative.");

  return {
    grossAmount,
    discount,
    taxableAmount,
    cgst,
    sgst,
    igst,
    taxAmount,
    isRCM: Boolean(isRCM),
    gstType: inter ? "INTER" : "INTRA",
    subtotal,
    roundOff,
    totalAmount: netPayable,
    netPayable,
  };
};

const PAYMENT_MODES = ["CASH", "UPI", "CARD", "BANK", "NEFT", "RTGS", "IMPS", "CHEQUE", "ONLINE", "OTHER"];

/** Direct (non-voucher) payments entered on the purchase form. */
export const buildDirectPayments = (rawPayments, storeId) => {
  if (!Array.isArray(rawPayments)) return [];
  return rawPayments
    .map((p, i) => {
      const amount = toMoney(p?.amount, { field: `Payment ${i + 1} amount` });
      if (amount <= 0) return null;
      const mode = String(p.paymentMode || "CASH").trim().toUpperCase();
      return {
        storeId,
        paymentMode: PAYMENT_MODES.includes(mode) ? mode : cleanString(mode, 30) || "CASH",
        paymentChannel: cleanString(p.paymentChannel, 50),
        amount,
        transactionId: cleanString(p.transactionId || p.referenceNo, 100),
        referenceNo: cleanString(p.referenceNo || p.transactionId, 100),
        description: cleanString(p.description, 500),
        paymentDate: toDate(p.paymentDate, { field: `Payment ${i + 1} date` }),
        narration: cleanString(p.narration, 500),
      };
    })
    .filter(Boolean);
};

/** Payments created by accounting vouchers are read-only from the purchase screen (PUR-05 / ACC-11). */
export const isVoucherPayment = (p) => Boolean(p && (p.voucherId || /^PV-/i.test(String(p.referenceNo || ""))));

/** Rule 1: balance == due == net - paid - adjusted (never < 0). */
export const settlementFields = ({ purchaseType, netPayable, paidAmount, adjustedAmount = 0 }) => {
  const due = roundMoney(Math.max(0, netPayable - paidAmount - adjustedAmount));
  const out = { paidAmount: roundMoney(paidAmount), dueAmount: due, balanceAmount: due, adjustedAmount: roundMoney(adjustedAmount) };
  if (purchaseType === "OLD") {
    out.adjustmentStatus = adjustedAmount > 0.01 ? (due > 0.01 ? "PARTIALLY_ADJUSTED" : "FULLY_ADJUSTED") : due > 0.01 ? "AVAILABLE" : "SETTLED";
  } else {
    out.adjustmentStatus = "AVAILABLE"; // only meaningful for OLD purchases
  }
  return out;
};

export { has };
