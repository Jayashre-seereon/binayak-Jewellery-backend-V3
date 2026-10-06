// Sale journal (BRIEF rule 3): one JOURNAL voucher per sale, posted inside the sale transaction.
import {
  postVoucher,
  ACCOUNTS,
  customerAccount,
  customerAdvanceAccount,
  paymentAccount,
} from "../../utils/ledger.js";
import { roundMoney } from "../../utils/validate.js";

export const saleJournalNo = (invoiceNo) => `SJ-${invoiceNo}`;

/**
 * @param tx       Prisma transaction
 * @param sale     created Sale row
 * @param settle   { payments:[{paymentMode,amount}], advances:[{advance,amount}], oldGolds:[{purchase,amount}], lessUrd }
 * @param user     req.user (for createdBy)
 */
export const postSaleJournal = async (tx, sale, settle, user = null) => {
  const customer = customerAccount(sale.customerName, sale.customerPhone);
  const inv = sale.invoiceNo;
  const roundOff = roundMoney(sale.roundOff);
  const entries = [
    { accountName: customer, debit: roundMoney(sale.subTotal + roundOff), narration: `Sale invoice ${inv}` },
    { accountName: ACCOUNTS.SALES, credit: sale.taxableAmount, narration: `Sales ${inv}` },
    { accountName: ACCOUNTS.OUTPUT_CGST, credit: sale.cgstAmount, narration: `Output CGST ${inv}` },
    { accountName: ACCOUNTS.OUTPUT_SGST, credit: sale.sgstAmount, narration: `Output SGST ${inv}` },
    { accountName: ACCOUNTS.OUTPUT_IGST, credit: sale.igstAmount, narration: `Output IGST ${inv}` },
  ];
  if (roundOff > 0) entries.push({ accountName: ACCOUNTS.ROUND_OFF, credit: roundOff, narration: `Round off ${inv}` });
  if (roundOff < 0) entries.push({ accountName: ACCOUNTS.ROUND_OFF, debit: -roundOff, narration: `Round off ${inv}` });

  for (const p of settle.payments || []) {
    entries.push({ accountName: paymentAccount(p.paymentMode), debit: p.amount, narration: `${p.paymentMode} received at counter for ${inv}` });
    entries.push({ accountName: customer, credit: p.amount, narration: `${p.paymentMode} received at counter for ${inv}` });
  }
  for (const { advance, amount } of settle.advances || []) {
    entries.push({
      accountName: customerAdvanceAccount(advance.customerName, advance.contactNumber),
      debit: amount,
      narration: `Advance ADV-${advance.id} adjusted in ${inv}`,
    });
    entries.push({ accountName: customer, credit: amount, narration: `Advance ADV-${advance.id} adjusted in ${inv}` });
  }
  for (const { purchase, amount } of settle.oldGolds || []) {
    const ref = purchase.invoiceNo || `PUR-OLD-${purchase.id}`;
    entries.push({ accountName: customerAccount(purchase.customerName, purchase.customerPhone), debit: amount, narration: `Old gold ${ref} exchanged in ${inv}` });
    entries.push({ accountName: customer, credit: amount, narration: `Old gold ${ref} exchanged in ${inv}` });
  }
  // "Less URD" has no purchase document: book it as an unregistered old-gold purchase so the
  // customer's receivable still equals the invoice due.
  if (settle.lessUrd > 0) {
    entries.push({ accountName: ACCOUNTS.OLD_GOLD_PURCHASE, debit: settle.lessUrd, narration: `Less URD in ${inv}` });
    entries.push({ accountName: customer, credit: settle.lessUrd, narration: `Less URD in ${inv}` });
  }

  return postVoucher(
    tx,
    {
      storeId: sale.storeId,
      voucherNo: saleJournalNo(inv),
      voucherType: "JOURNAL",
      referenceType: "SALE",
      referenceId: sale.id,
      referenceDocNo: inv,
      saleId: sale.id,
      customerId: sale.customerId || null,
      partyId: sale.partyId || null,
      partyType: "CUSTOMER",
      partyName: sale.customerName || "Walk-in",
      partyPhone: sale.customerPhone || null,
      date: sale.saleDate,
      amount: roundMoney(sale.subTotal),
      narration: `Sale invoice ${inv}`,
      createdBy: user?.name || user?.email || "System",
    },
    entries
  );
};
