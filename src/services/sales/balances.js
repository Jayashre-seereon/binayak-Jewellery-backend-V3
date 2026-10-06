// Shared rules for what part of an advance / old-gold purchase can still be used in a sale.
// Used by the sale transaction (authoritative) and by the customer lookup (display).
import { roundMoney, cleanPhone } from "../../utils/validate.js";

export const USABLE_ADVANCE_STATUSES = ["AVAILABLE", "PARTIALLY_ADJUSTED"];

export const last10 = (phone) => cleanPhone(phone).slice(-10);

/** Same customer = same customer row, or same 10-digit phone. */
export const belongsToCustomer = ({ ownerCustomerId, ownerPhone }, { customerId, phone }) => {
  if (customerId && ownerCustomerId && Number(ownerCustomerId) === Number(customerId)) return true;
  const a = last10(ownerPhone);
  const b = last10(phone);
  return a.length === 10 && a === b;
};

/** Sum of an advance's adjustments that belong to COMPLETED sales (needs saleAdjustments.sale.status). */
export const advanceUsedOnCompletedSales = (advance) =>
  roundMoney(
    (advance.saleAdjustments || [])
      .filter((sa) => !sa.sale || sa.sale.status !== "CANCELLED")
      .reduce((s, sa) => s + Number(sa.amount || sa.adjustedAmount || 0), 0)
  );

/** available = min(balanceAmount, amount − Σ adjustments on COMPLETED sales); 0 when not usable. */
export const advanceAvailable = (advance) => {
  if (!USABLE_ADVANCE_STATUSES.includes(String(advance.status || ""))) return 0;
  const amount = roundMoney(Number(advance.amount || 0));
  const byHistory = roundMoney(amount - advanceUsedOnCompletedSales(advance));
  return roundMoney(Math.max(0, Math.min(Number(advance.balanceAmount || 0), byHistory)));
};

export const oldGoldValuation = (purchase) =>
  roundMoney(Number(purchase.netPayable || purchase.totalAmount || purchase.grossAmount || 0));

/** Adjustable old-gold value = netPayable − paidAmount − adjustedAmount (never above balanceAmount). */
export const oldGoldAdjustable = (purchase) => {
  const byDue = roundMoney(oldGoldValuation(purchase) - Number(purchase.paidAmount || 0) - Number(purchase.adjustedAmount || 0));
  return roundMoney(Math.max(0, Math.min(Number(purchase.balanceAmount || 0), byDue)));
};
