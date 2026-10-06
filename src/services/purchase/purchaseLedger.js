// Purchase journal (BRIEF rule 3): PJ-{invoiceNo}, re-posted on update, cancelled on delete.
import {
  ACCOUNTS,
  postVoucher,
  cancelVoucherAtomic,
  paymentAccount,
  supplierAccount,
  customerAccount,
} from "../../utils/ledger.js";
import { roundMoney } from "../../utils/validate.js";

export const purchasePartyAccount = (purchase, party) =>
  party ? supplierAccount(party.name, party.phone) : customerAccount(purchase.customerName, purchase.customerPhone);

const activeJournalWhere = (purchaseId, storeId) => ({
  purchaseId: Number(purchaseId),
  storeId: Number(storeId),
  voucherType: "JOURNAL",
  referenceType: "PURCHASE",
  status: "COMPLETED",
});

/** Cancels every active purchase journal of the purchase (normally exactly one). */
export const cancelPurchaseJournal = async (tx, purchase, reason) => {
  const vouchers = await tx.voucher.findMany({ where: activeJournalWhere(purchase.id, purchase.storeId), select: { id: true } });
  for (const v of vouchers) {
    await cancelVoucherAtomic(tx, { voucherId: v.id, storeId: purchase.storeId, reason });
  }
  return vouchers.length;
};

/**
 * Posts the purchase journal. `directPayments` are the payments taken on the purchase form
 * (voucher-originated payments post their own Payment Vouchers and are excluded).
 */
export const postPurchaseJournal = async (tx, purchase, { party = null, directPayments = [] } = {}) => {
  const net = roundMoney(purchase.netPayable);
  const payments = directPayments.filter((p) => roundMoney(p.amount) > 0);
  if (net <= 0 && payments.length === 0) return null;

  const partyAcc = purchasePartyAccount(purchase, party);
  const purchaseAcc = purchase.purchaseType === "OLD" ? ACCOUNTS.OLD_GOLD_PURCHASE : ACCOUNTS.PURCHASE;
  const entries = [{ accountName: purchaseAcc, debit: purchase.taxableAmount }];
  if (!purchase.isRCM) {
    entries.push({ accountName: ACCOUNTS.INPUT_CGST, debit: purchase.cgst });
    entries.push({ accountName: ACCOUNTS.INPUT_SGST, debit: purchase.sgst });
    entries.push({ accountName: ACCOUNTS.INPUT_IGST, debit: purchase.igst });
  }
  const ro = roundMoney(purchase.roundOff);
  if (ro > 0) entries.push({ accountName: ACCOUNTS.ROUND_OFF, debit: ro });
  if (ro < 0) entries.push({ accountName: ACCOUNTS.ROUND_OFF, credit: -ro });
  entries.push({ accountName: partyAcc, credit: net });
  for (const p of payments) {
    const narration = `Paid on purchase ${purchase.invoiceNo} (${String(p.paymentMode || "CASH").toUpperCase()})`;
    entries.push({ accountName: partyAcc, debit: p.amount, narration });
    entries.push({ accountName: paymentAccount(p.paymentMode), credit: p.amount, narration });
  }

  const base = `PJ-${purchase.invoiceNo}`;
  const previous = await tx.voucher.count({ where: { storeId: Number(purchase.storeId), voucherNo: { startsWith: base } } });
  const voucherNo = previous === 0 ? base : `${base}-R${previous}`;

  return postVoucher(
    tx,
    {
      voucherNo,
      voucherType: "JOURNAL",
      referenceType: "PURCHASE",
      referenceId: purchase.id,
      referenceDocNo: purchase.invoiceNo,
      purchaseId: purchase.id,
      storeId: purchase.storeId,
      date: purchase.date,
      amount: net,
      partyType: party ? "SUPPLIER" : "CUSTOMER",
      partyId: party ? party.id : null,
      partyName: party ? party.name : purchase.customerName || "Walk-in",
      partyPhone: party ? party.phone || null : purchase.customerPhone || null,
      customerId: party ? null : purchase.customerId || null,
      narration: `${purchase.purchaseType} purchase ${purchase.invoiceNo}`,
      createdBy: "System",
    },
    entries
  );
};
