import prisma from "../config/db.js";
import { generateVoucherNo, peekNextVoucherNo } from "../utils/voucherCodeGenerator.js";
import { getOrCreateCustomerService } from "./customerService.js";
import { AppError, roundMoney, toMoney, parseId, cleanString } from "../utils/validate.js";
import {
  ACCOUNTS,
  postVoucher,
  cancelVoucherAtomic,
  ensureSystemAccounts,
  paymentAccount,
  customerAccount,
  customerAdvanceAccount,
  supplierAccount,
} from "../utils/ledger.js";
import { publicStoreSelect } from "../utils/publicSelect.js";
import {
  DEFAULT_ACCOUNTS,
  EXPENSE_ACCOUNT_BY_TYPE,
  LEGACY_REFERENCE_TYPES,
  SYSTEM_JOURNAL_TYPES,
  actorOf,
  dayWindow,
  exactPhone,
  monthWindow,
  parsePagination,
  parsePaymentMode,
  parseVoucherDate,
  resolveAccountName,
  todayWindow,
} from "./accounting/helpers.js";

export { DEFAULT_ACCOUNTS };

const TX_OPTIONS = { maxWait: 20000, timeout: 60000 };
const EPS = 0.01;

const requireStoreId = (storeId) => {
  const sid = Number(storeId);
  if (!Number.isInteger(sid) || sid <= 0) throw new AppError("Please select a store.");
  return sid;
};

const fmt = (n) => roundMoney(n).toFixed(2);

// ------------------------------------------------------------------ accounts

const seededStores = new Set();

/**
 * Upserts every default / system ledger by name, whatever else the store already has
 * (migrated stores carry their own ledgers but not these names).
 */
export const ensureDefaultAccounts = async (storeId, tx = prisma) => {
  const sid = Number(storeId);
  if (!sid) return;
  if (tx === prisma && seededStores.has(sid)) return;
  for (const acc of DEFAULT_ACCOUNTS) {
    await tx.account.upsert({
      where: { storeId_accountName: { storeId: sid, accountName: acc.accountName } },
      update: {},
      create: { storeId: sid, ...acc },
    });
  }
  await ensureSystemAccounts(sid, tx);
  if (tx === prisma) seededStores.add(sid);
};

export const getAccountsService = async (storeId) => {
  const sid = requireStoreId(storeId);
  await ensureDefaultAccounts(sid);
  return prisma.account.findMany({
    where: { storeId: sid },
    orderBy: [{ accountGroup: "asc" }, { accountName: "asc" }],
  });
};

const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "INCOME", "EXPENSE", "EQUITY"];

/** Creates a user-defined ledger account (journal lines may only use existing accounts). */
export const createAccountService = async (data = {}, storeId) => {
  const sid = requireStoreId(storeId);
  const accountName = cleanString(data.accountName, 120)?.replace(/\s+/g, " ");
  if (!accountName) throw new AppError("Account name is required.");
  if (/^(Customer|Customer Advance|Supplier):/i.test(accountName)) {
    throw new AppError("Party ledgers are created automatically from sales, purchases and vouchers.");
  }
  const accountType = String(data.accountType || "EXPENSE").toUpperCase();
  if (!ACCOUNT_TYPES.includes(accountType)) throw new AppError(`Account type must be one of ${ACCOUNT_TYPES.join(", ")}.`);
  const dup = await prisma.account.findFirst({
    where: { storeId: sid, accountName: { equals: accountName, mode: "insensitive" } },
    select: { id: true },
  });
  if (dup) throw new AppError(`Account "${accountName}" already exists in this store.`, 409);
  return prisma.account.create({
    data: {
      storeId: sid,
      accountName,
      accountGroup: cleanString(data.accountGroup, 80) || "General",
      accountType,
      accountCode: cleanString(data.accountCode, 40),
      narration: cleanString(data.narration, 300),
      isSystem: false,
    },
  });
};

// ------------------------------------------------------------------ pending dues

export const getCustomerPendingSalesService = async (customerId, phone, storeId) => {
  const sid = requireStoreId(storeId);
  const p = exactPhone(phone);
  const cid = customerId ? parseId(customerId, "customerId") : null;
  if (!cid && !p) return [];

  return prisma.sale.findMany({
    where: {
      storeId: sid,
      status: "COMPLETED",
      dueAmount: { gt: EPS },
      OR: [...(cid ? [{ customerId: cid }] : []), ...(p ? [{ customerPhone: { endsWith: p } }] : [])],
    },
    select: {
      id: true,
      invoiceNo: true,
      saleDate: true,
      customerName: true,
      customerPhone: true,
      netPayable: true,
      paidAmount: true,
      dueAmount: true,
      advanceAmount: true,
      oldGoldAmount: true,
      totalTax: true,
    },
    orderBy: { saleDate: "desc" },
  });
};

/** Resolves the supplier for a payment/lookup: party id first, else a party with that exact phone. */
const findSupplierParty = async (db, storeId, { partyId, phone }) => {
  if (partyId) {
    const party = await db.partymaster.findFirst({ where: { id: partyId, storeId }, include: { partytype: true } });
    if (!party) throw new AppError("Supplier not found in this store.", 404);
    return party;
  }
  if (phone) {
    return db.partymaster.findFirst({ where: { storeId, phone: { endsWith: phone } }, include: { partytype: true }, orderBy: { id: "asc" } });
  }
  return null;
};

/** Where clause for a supplier's purchases: by party when known, else exact phone on party-less purchases. */
const supplierPurchaseWhere = (storeId, party, phone) => {
  if (party) return { storeId, partyId: party.id };
  return { storeId, partyId: null, customerPhone: { endsWith: phone } };
};

export const getSupplierPendingPurchasesService = async (param, storeId) => {
  const sid = requireStoreId(storeId);
  const rawPartyId = typeof param === "object" && param !== null ? param.partyId : param;
  const partyId = rawPartyId ? parseId(rawPartyId, "partyId") : null;
  const phone = exactPhone(typeof param === "object" && param !== null ? param.phone : null);

  if (!partyId && !phone) return { supplier: null, totalOutstandingDue: 0, data: [] };

  let supplier = await findSupplierParty(prisma, sid, { partyId, phone });
  const purchases = await prisma.purchase.findMany({
    where: { ...supplierPurchaseWhere(sid, supplier, phone), dueAmount: { gt: EPS } },
    select: {
      id: true,
      invoiceNo: true,
      date: true,
      customerName: true,
      customerPhone: true,
      referenceNo: true,
      netPayable: true,
      paidAmount: true,
      dueAmount: true,
      totalAmount: true,
      purchaseType: true,
      partyId: true,
      party: { select: { id: true, name: true, phone: true, gst: true, address: true } },
    },
    orderBy: { date: "desc" },
  });

  const totalOutstandingDue = roundMoney(purchases.reduce((sum, p) => sum + Number(p.dueAmount || 0), 0));

  if (!supplier && purchases.length > 0) {
    const first = purchases[0];
    supplier = { id: null, name: first.customerName || "Supplier", phone: first.customerPhone || phone };
  }

  return { supplier, totalOutstandingDue, data: purchases };
};

export const getPendingSuppliersService = async (storeId) => {
  const sid = requireStoreId(storeId);
  const pending = await prisma.purchase.findMany({
    where: { storeId: sid, dueAmount: { gt: EPS } },
    select: {
      id: true,
      partyId: true,
      customerName: true,
      customerPhone: true,
      dueAmount: true,
      party: { select: { id: true, name: true, phone: true, gst: true, address: true, partytype: { select: { name: true } } } },
    },
    orderBy: { date: "desc" },
  });

  const map = new Map();
  for (const pur of pending) {
    const phone = exactPhone(pur.party?.phone || pur.customerPhone);
    // Same keys the payment flow uses: a party, or an exact phone on party-less purchases.
    const key = pur.partyId ? `party_${pur.partyId}` : phone ? `phone_${phone}` : `pur_${pur.id}`;
    if (!map.has(key)) {
      map.set(key, {
        partyId: pur.partyId || null,
        name: pur.party?.name || pur.customerName || "Supplier",
        phone: phone || pur.party?.phone || pur.customerPhone || "-",
        gst: pur.party?.gst || "",
        address: pur.party?.address || "",
        partyTypeName: pur.party?.partytype?.name || "Supplier",
        totalDueAmount: 0,
        pendingInvoicesCount: 0,
      });
    }
    const row = map.get(key);
    row.totalDueAmount = roundMoney(row.totalDueAmount + Number(pur.dueAmount || 0));
    row.pendingInvoicesCount += 1;
  }
  return Array.from(map.values()).sort((a, b) => b.totalDueAmount - a.totalDueAmount);
};

// ------------------------------------------------------------------ receipts

const SALE_PAYMENT_MODE = { CASH: "CASH", UPI: "UPI", BANK_TRANSFER: "ONLINE", CARD: "CARD", CHEQUE: "CHEQUE", OTHER: "OTHER" };

const commonVoucherFields = (data, paymentMode, user) => ({
  paymentMode,
  bankName: paymentMode === "CASH" ? null : cleanString(data.bankName, 120),
  transactionRef: cleanString(data.transactionRef, 120),
  createdBy: actorOf(user),
});

const receiveAgainstSale = async (tx, { sid, data, amount, date, paymentMode, user }) => {
  const saleId = parseId(data.saleId || data.referenceId, "sale invoice");
  const sale = await tx.sale.findFirst({ where: { id: saleId, storeId: sid } });
  if (!sale) throw new AppError(`Sale invoice #${saleId} not found in this store.`, 404);
  if (sale.status === "CANCELLED") throw new AppError(`Sale invoice ${sale.invoiceNo} has been cancelled.`);
  if (amount > roundMoney(sale.dueAmount) + EPS) {
    throw new AppError(`Received amount (₹${fmt(amount)}) cannot exceed the pending due amount (₹${fmt(sale.dueAmount)}) for invoice ${sale.invoiceNo}.`);
  }

  // Conditional atomic update: a concurrent receipt that already consumed the due makes this 0 rows.
  const upd = await tx.sale.updateMany({
    where: { id: sale.id, storeId: sid, status: "COMPLETED", dueAmount: { gte: amount - EPS } },
    data: { paidAmount: { increment: amount }, dueAmount: { decrement: amount } },
  });
  if (upd.count === 0) {
    throw new AppError(`The due on invoice ${sale.invoiceNo} changed while saving (another receipt was recorded). Refresh and try again.`, 409);
  }
  await tx.sale.updateMany({ where: { id: sale.id, dueAmount: { lt: 0 } }, data: { dueAmount: 0 } });

  const voucherNo = await generateVoucherNo(sid, "RECEIPT", tx);
  const voucher = await postVoucher(
    tx,
    {
      voucherNo,
      voucherType: "RECEIPT",
      storeId: sid,
      date,
      amount,
      referenceType: "SALE_INVOICE",
      referenceId: sale.id,
      referenceDocNo: sale.invoiceNo,
      partyType: "CUSTOMER",
      partyId: sale.partyId,
      customerId: sale.customerId,
      partyName: sale.customerName || cleanString(data.receivedFrom, 120) || "Customer",
      partyPhone: sale.customerPhone || null,
      narration: cleanString(data.narration) || `Received ₹${fmt(amount)} against Sale Invoice ${sale.invoiceNo}`,
      saleId: sale.id,
      ...commonVoucherFields(data, paymentMode, user),
    },
    [
      { accountName: paymentAccount(paymentMode), debit: amount, narration: `Receipt ${voucherNo} via ${paymentMode}` },
      { accountName: customerAccount(sale.customerName, sale.customerPhone), credit: amount, narration: `Paid against sale ${sale.invoiceNo}` },
    ]
  );

  await tx.salePayment.create({
    data: {
      saleId: sale.id,
      storeId: sid,
      voucherId: voucher.id,
      paymentMode: SALE_PAYMENT_MODE[paymentMode] || "OTHER",
      amount,
      referenceNo: voucherNo,
      transactionId: cleanString(data.transactionRef, 120),
      description: cleanString(data.narration) || `Receipt Voucher ${voucherNo}`,
      paymentDate: date,
      narration: cleanString(data.narration),
    },
  });
  return voucher;
};

const receiveAdvance = async (tx, { sid, data, amount, date, paymentMode, user }) => {
  const customerName = cleanString(data.receivedFrom || data.customerName, 120);
  if (!customerName) throw new AppError("Customer name is required for an advance receipt.");
  const rawPhone = data.partyPhone ?? data.customerPhone ?? data.contactNumber;
  const customerPhone = exactPhone(rawPhone);
  if (cleanString(rawPhone) && !customerPhone) throw new AppError("Enter a valid 10-digit customer phone number.");

  let customerId = null;
  if (data.customerId) {
    const c = await tx.customer.findFirst({ where: { id: parseId(data.customerId, "customerId"), storeId: sid }, select: { id: true } });
    if (!c) throw new AppError("Customer not found in this store.", 404);
    customerId = c.id;
  } else if (customerPhone) {
    const cust = await getOrCreateCustomerService({ customerName, customerPhone, customerAddress: cleanString(data.address) }, sid, tx);
    customerId = cust?.id || null;
  }

  const voucherNo = await generateVoucherNo(sid, "RECEIPT", tx);
  const advance = await tx.advanceReceive.create({
    data: {
      customerId,
      customerName,
      contactNumber: customerPhone || null,
      address: cleanString(data.address),
      amount,
      adjustedAmount: 0,
      balanceAmount: amount,
      status: "AVAILABLE",
      receiveDate: date,
      paymentMode: paymentMode === "CASH" ? "CASH" : "ONLINE",
      specification: `Receipt Voucher ${voucherNo}`,
      storeId: sid,
    },
  });

  return postVoucher(
    tx,
    {
      voucherNo,
      voucherType: "RECEIPT",
      storeId: sid,
      date,
      amount,
      referenceType: "ADVANCE",
      referenceId: advance.id,
      referenceDocNo: `ADV-${advance.id}`,
      partyType: "CUSTOMER",
      customerId,
      partyName: customerName,
      partyPhone: customerPhone || null,
      narration: cleanString(data.narration) || `Customer advance received of ₹${fmt(amount)}`,
      advanceReceiveId: advance.id,
      ...commonVoucherFields(data, paymentMode, user),
    },
    [
      { accountName: paymentAccount(paymentMode), debit: amount, narration: `Advance received via ${paymentMode}` },
      { accountName: customerAdvanceAccount(customerName, customerPhone), credit: amount, narration: `Customer advance ADV-${advance.id}` },
    ]
  );
};

const receiveOther = async (tx, { sid, data, amount, date, paymentMode, user }) => {
  const receivedFrom = cleanString(data.receivedFrom || data.partyName, 120) || "Other Source";
  const incomeAccount = data.accountName ? await resolveAccountName(tx, sid, data.accountName, { field: "Income account" }) : ACCOUNTS.OTHER_INCOME;
  const voucherNo = await generateVoucherNo(sid, "RECEIPT", tx);
  const narration = cleanString(data.narration) || `Received from ${receivedFrom}`;
  return postVoucher(
    tx,
    {
      voucherNo,
      voucherType: "RECEIPT",
      storeId: sid,
      date,
      amount,
      referenceType: "OTHER",
      referenceDocNo: cleanString(data.referenceDocNo, 120),
      partyType: "OTHER",
      partyName: receivedFrom,
      partyPhone: exactPhone(data.partyPhone) || null,
      narration,
      ...commonVoucherFields(data, paymentMode, user),
    },
    [
      { accountName: paymentAccount(paymentMode), debit: amount, narration: `Received via ${paymentMode}` },
      { accountName: incomeAccount, credit: amount, narration },
    ]
  );
};

export const createReceiptVoucherService = async (data = {}, storeId, user = null) => {
  const sid = requireStoreId(storeId);
  const amount = toMoney(data.amount, { field: "Receipt amount", required: true });
  if (amount <= 0) throw new AppError("Receipt amount must be greater than 0.");
  const paymentMode = parsePaymentMode(data.paymentMode);
  const referenceType = String(data.referenceType || "OTHER").toUpperCase();
  const date = parseVoucherDate(data.date);
  const ctx = { sid, data, amount, date, paymentMode, user };

  await ensureDefaultAccounts(sid);

  return prisma.$transaction(async (tx) => {
    if (referenceType === "SALE_INVOICE") return receiveAgainstSale(tx, ctx);
    if (referenceType === "ADVANCE") return receiveAdvance(tx, ctx);
    if (referenceType === "OTHER") return receiveOther(tx, ctx);
    throw new AppError(`Invalid receipt type: ${data.referenceType}`);
  }, TX_OPTIONS);
};

// ------------------------------------------------------------------ payments

/** Supplier/party ledger for a purchase — same rule the purchase module uses for its PJ journal. */
const purchasePartyAccount = (purchase) =>
  purchase.partyId && purchase.party
    ? supplierAccount(purchase.party.name, purchase.party.phone)
    : customerAccount(purchase.customerName, purchase.customerPhone);

/** What can still be paid in cash: OLD purchases are also limited by the unadjusted balance (BRIEF rule 1). */
const payableOf = (p) =>
  roundMoney(p.purchaseType === "OLD" ? Math.max(0, Math.min(Number(p.dueAmount || 0), Number(p.balanceAmount || 0))) : Number(p.dueAmount || 0));

/** Atomically applies a payment to one purchase (OLD purchases also reduce balanceAmount — BRIEF rule 1). */
const applyPurchasePayment = async (tx, sid, purchase, amount) => {
  const isOld = purchase.purchaseType === "OLD";
  const upd = await tx.purchase.updateMany({
    where: {
      id: purchase.id,
      storeId: sid,
      dueAmount: { gte: amount - EPS },
      ...(isOld ? { balanceAmount: { gte: amount - EPS } } : {}),
    },
    data: {
      paidAmount: { increment: amount },
      dueAmount: { decrement: amount },
      ...(isOld ? { balanceAmount: { decrement: amount } } : {}),
    },
  });
  if (upd.count === 0) {
    throw new AppError(
      `The due on purchase ${purchase.invoiceNo || `#${purchase.id}`} changed while saving (another payment or old-gold adjustment). Refresh and try again.`,
      409
    );
  }
  await tx.purchase.updateMany({ where: { id: purchase.id, dueAmount: { lt: 0 } }, data: { dueAmount: 0 } });
  if (isOld) {
    await tx.purchase.updateMany({ where: { id: purchase.id, balanceAmount: { lt: 0 } }, data: { balanceAmount: 0 } });
    await tx.purchase.updateMany({
      where: { id: purchase.id, balanceAmount: { lte: EPS }, adjustmentStatus: "AVAILABLE" },
      data: { adjustmentStatus: "SETTLED" },
    });
  }
};

/** Reverses a payment on one purchase (cancel). */
const revertPurchasePayment = async (tx, sid, purchaseId, amount) => {
  const purchase = await tx.purchase.findFirst({ where: { id: purchaseId, storeId: sid } });
  if (!purchase) return;
  const isOld = purchase.purchaseType === "OLD";
  await tx.purchase.update({
    where: { id: purchase.id },
    data: {
      paidAmount: { decrement: amount },
      dueAmount: { increment: amount },
      ...(isOld ? { balanceAmount: { increment: amount } } : {}),
    },
  });
  await tx.purchase.updateMany({ where: { id: purchase.id, paidAmount: { lt: 0 } }, data: { paidAmount: 0 } });
  if (isOld && purchase.adjustmentStatus === "SETTLED") {
    await tx.purchase.update({
      where: { id: purchase.id },
      data: { adjustmentStatus: Number(purchase.adjustedAmount || 0) > EPS ? "PARTIALLY_ADJUSTED" : "AVAILABLE" },
    });
  }
};

const paySupplier = async (tx, { sid, data, amount, date, paymentMode, user }) => {
  const allocations = []; // { purchase, amount }

  if (data.purchaseId || data.referenceId) {
    const purchaseId = parseId(data.purchaseId || data.referenceId, "purchase");
    const purchase = await tx.purchase.findFirst({ where: { id: purchaseId, storeId: sid }, include: { party: true } });
    if (!purchase) throw new AppError(`Purchase #${purchaseId} not found in this store.`, 404);
    const payable = payableOf(purchase);
    if (amount > payable + EPS) {
      throw new AppError(
        purchase.purchaseType === "OLD" && payable < roundMoney(purchase.dueAmount) - EPS
          ? `Old-gold purchase ${purchase.invoiceNo || `#${purchase.id}`} has only ₹${fmt(payable)} left to pay; the rest was adjusted against sales.`
          : `Payment amount (₹${fmt(amount)}) cannot exceed the pending balance (₹${fmt(payable)}) for purchase ${purchase.invoiceNo || `#${purchase.id}`}.`
      );
    }
    allocations.push({ purchase, amount });
  } else {
    // Settle the supplier's dues oldest-first.
    const partyId = data.partyId ? parseId(data.partyId, "partyId") : null;
    const phone = exactPhone(data.partyPhone);
    if (!partyId && !phone) throw new AppError("Select a supplier (or enter a valid 10-digit phone) for a supplier payment.");
    const party = await findSupplierParty(tx, sid, { partyId, phone });
    const pending = await tx.purchase.findMany({
      where: { ...supplierPurchaseWhere(sid, party, phone), dueAmount: { gt: EPS } },
      include: { party: true },
      orderBy: [{ date: "asc" }, { id: "asc" }],
    });
    if (!pending.length) throw new AppError("No pending purchases with outstanding dues were found for this supplier.");
    const totalDue = roundMoney(pending.reduce((s, p) => s + payableOf(p), 0));
    if (amount > totalDue + EPS) {
      throw new AppError(`Payment amount (₹${fmt(amount)}) cannot exceed the supplier's total outstanding due of ₹${fmt(totalDue)}.`);
    }
    let remaining = amount;
    for (const purchase of pending) {
      if (remaining <= EPS) break;
      const pay = roundMoney(Math.min(remaining, payableOf(purchase)));
      if (pay <= 0) continue;
      allocations.push({ purchase, amount: pay });
      remaining = roundMoney(remaining - pay);
    }
  }

  for (const a of allocations) await applyPurchasePayment(tx, sid, a.purchase, a.amount);

  const single = allocations.length === 1 ? allocations[0].purchase : null;
  const first = allocations[0].purchase;
  const partyName =
    cleanString(data.payTo, 120) || first.party?.name || first.customerName || "Supplier";

  // One debit line per party ledger (FIFO allocations normally share one ledger).
  const debitByAccount = new Map();
  for (const a of allocations) {
    const acc = purchasePartyAccount(a.purchase);
    debitByAccount.set(acc, roundMoney((debitByAccount.get(acc) || 0) + a.amount));
  }
  const invoiceList = allocations.map((a) => a.purchase.invoiceNo || `#${a.purchase.id}`).join(", ");

  const voucherNo = await generateVoucherNo(sid, "PAYMENT", tx);
  const voucher = await postVoucher(
    tx,
    {
      voucherNo,
      voucherType: "PAYMENT",
      storeId: sid,
      date,
      amount,
      referenceType: "PURCHASE",
      referenceId: single?.id || null,
      referenceDocNo: single ? single.invoiceNo || single.referenceNo || `#${single.id}` : "MULTIPLE",
      partyType: "SUPPLIER",
      partyId: first.partyId || null,
      partyName,
      partyPhone: first.party?.phone || first.customerPhone || exactPhone(data.partyPhone) || null,
      narration: cleanString(data.narration) || `Paid ₹${fmt(amount)} against purchase ${invoiceList}`.slice(0, 500),
      purchaseId: single?.id || null,
      ...commonVoucherFields(data, paymentMode, user),
    },
    [
      ...Array.from(debitByAccount, ([accountName, debit]) => ({ accountName, debit, narration: `Paid for purchase ${invoiceList}`.slice(0, 300) })),
      { accountName: paymentAccount(paymentMode), credit: amount, narration: `Payment ${voucherNo} via ${paymentMode}` },
    ]
  );

  for (const a of allocations) {
    await tx.purchasePayment.create({
      data: {
        purchaseId: a.purchase.id,
        storeId: sid,
        voucherId: voucher.id,
        paymentMode,
        amount: a.amount,
        referenceNo: voucherNo,
        transactionId: cleanString(data.transactionRef, 120),
        description: cleanString(data.narration) || `Payment Voucher ${voucherNo}`,
        paymentDate: date,
        narration: cleanString(data.narration),
      },
    });
  }
  return voucher;
};

const payExpense = async (tx, { sid, data, amount, date, paymentMode, user, referenceType }) => {
  const payTo = cleanString(data.payTo || data.partyName, 120);
  if (!payTo) throw new AppError("Pay To / party name is required.");
  const debitAccount =
    ["EXPENSE", "OTHER"].includes(referenceType) && data.accountName
      ? await resolveAccountName(tx, sid, data.accountName, { field: "Expense account" })
      : EXPENSE_ACCOUNT_BY_TYPE[referenceType];

  let partyId = null;
  if (data.partyId) {
    const party = await tx.partymaster.findFirst({ where: { id: parseId(data.partyId, "partyId"), storeId: sid }, select: { id: true } });
    partyId = party?.id || null;
  }

  const voucherNo = await generateVoucherNo(sid, "PAYMENT", tx);
  return postVoucher(
    tx,
    {
      voucherNo,
      voucherType: "PAYMENT",
      storeId: sid,
      date,
      amount,
      referenceType,
      referenceDocNo: cleanString(data.referenceDocNo, 120),
      partyType: referenceType === "SALARY" ? "EMPLOYEE" : "EXPENSE",
      partyId,
      partyName: payTo,
      partyPhone: exactPhone(data.partyPhone) || null,
      narration: cleanString(data.narration) || `Payment for ${referenceType.toLowerCase()} to ${payTo}`,
      ...commonVoucherFields(data, paymentMode, user),
    },
    [
      { accountName: debitAccount, debit: amount, narration: `Paid to ${payTo}` },
      { accountName: paymentAccount(paymentMode), credit: amount, narration: `Payment ${voucherNo} via ${paymentMode}` },
    ]
  );
};

export const createPaymentVoucherService = async (data = {}, storeId, user = null) => {
  const sid = requireStoreId(storeId);
  const amount = toMoney(data.amount, { field: "Payment amount", required: true });
  if (amount <= 0) throw new AppError("Payment amount must be greater than 0.");
  const paymentMode = parsePaymentMode(data.paymentMode);
  const referenceType = String(data.referenceType || "EXPENSE").toUpperCase();
  if (referenceType !== "PURCHASE" && !EXPENSE_ACCOUNT_BY_TYPE[referenceType]) {
    throw new AppError(`Invalid payment type: ${data.referenceType}`);
  }
  const date = parseVoucherDate(data.date);
  const ctx = { sid, data, amount, date, paymentMode, user, referenceType };

  await ensureDefaultAccounts(sid);

  return prisma.$transaction(
    async (tx) => (referenceType === "PURCHASE" ? paySupplier(tx, ctx) : payExpense(tx, ctx)),
    TX_OPTIONS
  );
};

// ------------------------------------------------------------------ journals

export const createJournalEntryService = async (data = {}, storeId, user = null) => {
  const sid = requireStoreId(storeId);
  if (!Array.isArray(data.entries) || data.entries.length < 2) {
    throw new AppError("A journal entry needs at least two lines.");
  }
  if (data.entries.length > 100) throw new AppError("A journal entry can have at most 100 lines.");

  let totalDebit = 0;
  let totalCredit = 0;
  const lines = data.entries.map((item, index) => {
    const row = index + 1;
    const accountName = String(item?.accountName || item?.ledger || "").trim();
    if (!accountName) throw new AppError(`Account / ledger name is required on row ${row}.`);
    const debit = toMoney(item.debit, { field: `Debit on row ${row}` });
    const credit = toMoney(item.credit, { field: `Credit on row ${row}` });
    if (debit > 0 && credit > 0) throw new AppError(`Row ${row} must have either a debit or a credit, not both.`);
    if (debit === 0 && credit === 0) throw new AppError(`Row ${row} must have a debit or a credit amount.`);
    totalDebit = roundMoney(totalDebit + debit);
    totalCredit = roundMoney(totalCredit + credit);
    return { accountName, debit, credit, narration: cleanString(item.narration, 300) };
  });

  if (totalDebit <= 0) throw new AppError("Journal total must be greater than 0.");
  if (Math.abs(totalDebit - totalCredit) > EPS) {
    throw new AppError(
      `Total debit (₹${fmt(totalDebit)}) must equal total credit (₹${fmt(totalCredit)}). Difference: ₹${fmt(Math.abs(totalDebit - totalCredit))}.`
    );
  }
  const date = parseVoucherDate(data.date);

  await ensureDefaultAccounts(sid);

  return prisma.$transaction(async (tx) => {
    const entries = [];
    for (const [i, l] of lines.entries()) {
      entries.push({ ...l, accountName: await resolveAccountName(tx, sid, l.accountName, { field: `Account on row ${i + 1}` }) });
    }
    const voucherNo = await generateVoucherNo(sid, "JOURNAL", tx);
    return postVoucher(
      tx,
      {
        voucherNo,
        voucherType: "JOURNAL",
        storeId: sid,
        date,
        amount: totalDebit,
        paymentMode: "OTHER",
        referenceType: "JOURNAL_ADJUSTMENT",
        narration: cleanString(data.narration) || "Manual journal adjustment",
        createdBy: actorOf(user),
      },
      entries
    );
  }, TX_OPTIONS);
};

// ------------------------------------------------------------------ cancellation

const reverseSaleReceipt = async (tx, sid, voucher) => {
  const saleId = voucher.saleId || voucher.referenceId;
  let payments = await tx.salePayment.findMany({ where: { storeId: sid, voucherId: voucher.id } });
  if (!payments.length && saleId) {
    // Legacy rows (created before voucherId existed): matched by number within this store only.
    payments = await tx.salePayment.findMany({ where: { storeId: sid, saleId, voucherId: null, referenceNo: voucher.voucherNo } });
  }
  const amount = payments.length ? roundMoney(payments.reduce((s, p) => s + Number(p.amount || 0), 0)) : roundMoney(voucher.amount);
  if (saleId) {
    await tx.sale.updateMany({
      where: { id: saleId, storeId: sid },
      data: { paidAmount: { decrement: amount }, dueAmount: { increment: amount } },
    });
    await tx.sale.updateMany({ where: { id: saleId, paidAmount: { lt: 0 } }, data: { paidAmount: 0 } });
  }
  if (payments.length) await tx.salePayment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } });
};

const reverseAdvanceReceipt = async (tx, sid, voucher) => {
  const advanceId = voucher.advanceReceiveId || voucher.referenceId;
  if (!advanceId) return;
  const adv = await tx.advanceReceive.findFirst({ where: { id: advanceId, storeId: sid } });
  if (!adv) return;
  // Only an untouched advance can be cancelled; the condition makes this race-safe against a sale using it.
  const upd = await tx.advanceReceive.updateMany({
    where: { id: adv.id, storeId: sid, adjustedAmount: { lte: EPS }, status: { in: ["AVAILABLE"] } },
    data: { status: "CANCELLED", balanceAmount: 0 },
  });
  if (upd.count === 0) {
    throw new AppError(
      Number(adv.adjustedAmount || 0) > EPS
        ? `Cannot cancel this receipt: ₹${fmt(adv.adjustedAmount)} of the advance has already been adjusted against sales.`
        : `Cannot cancel this receipt: the advance is ${String(adv.status).toLowerCase().replace(/_/g, " ")}.`
    );
  }
};

const reverseSupplierPayment = async (tx, sid, voucher) => {
  let payments = await tx.purchasePayment.findMany({ where: { storeId: sid, voucherId: voucher.id } });
  if (!payments.length) {
    // Legacy rows: same store, same number, written together with the voucher.
    const created = new Date(voucher.createdAt).getTime();
    payments = await tx.purchasePayment.findMany({
      where: {
        storeId: sid,
        voucherId: null,
        referenceNo: voucher.voucherNo,
        createdAt: { gte: new Date(created - 5 * 60000), lte: new Date(created + 5 * 60000) },
      },
    });
  }
  if (payments.length) {
    for (const p of payments) await revertPurchasePayment(tx, sid, p.purchaseId, roundMoney(p.amount));
    await tx.purchasePayment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } });
  } else if (voucher.purchaseId || voucher.referenceId) {
    await revertPurchasePayment(tx, sid, voucher.purchaseId || voucher.referenceId, roundMoney(voucher.amount));
  }
};

export const cancelVoucherService = async (voucherId, storeId, reason, user = null) => {
  const sid = requireStoreId(storeId);
  const id = parseId(voucherId, "voucher id");
  const why = cleanString(reason, 300);
  if (!why) throw new AppError("A reason is required to cancel a voucher.");
  const by = String(user?.email || user?.name || "unknown").slice(0, 120);

  return prisma.$transaction(async (tx) => {
    const voucher = await tx.voucher.findFirst({ where: { id, storeId: sid } });
    if (!voucher) throw new AppError(`Voucher #${id} not found.`, 404);
    if (LEGACY_REFERENCE_TYPES.includes(voucher.referenceType)) {
      throw new AppError(`Voucher ${voucher.voucherNo} is a migrated historical record and cannot be cancelled.`);
    }
    if (voucher.voucherType === "JOURNAL" && SYSTEM_JOURNAL_TYPES.includes(voucher.referenceType)) {
      throw new AppError(`Voucher ${voucher.voucherNo} was posted by a ${voucher.referenceType.toLowerCase()}; cancel the ${voucher.referenceType.toLowerCase()} instead.`);
    }
    if (voucher.status === "CANCELLED") throw new AppError(`Voucher ${voucher.voucherNo} is already cancelled.`);

    // First writer wins: only the request that flips COMPLETED -> CANCELLED performs reversals.
    const flipped = await cancelVoucherAtomic(tx, { voucherId: voucher.id, storeId: sid, reason: `${why} — by ${by}` });
    if (!flipped) throw new AppError(`Voucher ${voucher.voucherNo} is already cancelled.`);

    if (voucher.voucherType === "RECEIPT" && voucher.referenceType === "SALE_INVOICE") await reverseSaleReceipt(tx, sid, voucher);
    else if (voucher.voucherType === "RECEIPT" && voucher.referenceType === "ADVANCE") await reverseAdvanceReceipt(tx, sid, voucher);
    else if (voucher.voucherType === "PAYMENT" && voucher.referenceType === "PURCHASE") await reverseSupplierPayment(tx, sid, voucher);

    return tx.voucher.findUnique({ where: { id: voucher.id } });
  }, TX_OPTIONS);
};

// ------------------------------------------------------------------ lists & lookups

const VOUCHER_STATUSES = ["COMPLETED", "CANCELLED"];

export const getVouchersService = async (type, storeId, query = {}) => {
  const sid = requireStoreId(storeId);
  const voucherType = String(type).toUpperCase();
  const { page, limit, skip } = parsePagination(query);

  const where = { storeId: sid, voucherType };
  const and = [];

  const status = String(query.status || "").toUpperCase();
  if (status && status !== "ALL") {
    if (!VOUCHER_STATUSES.includes(status)) throw new AppError(`Invalid status filter: ${query.status}`);
    where.status = status;
  }
  const mode = String(query.paymentMode || "").toUpperCase();
  if (mode && mode !== "ALL") where.paymentMode = mode;

  const refType = cleanString(query.referenceType, 60);
  if (refType && refType.toUpperCase() !== "ALL") {
    where.referenceType = refType;
  } else if (voucherType === "JOURNAL" && !["1", "true", "yes"].includes(String(query.includeSystem || "").toLowerCase())) {
    and.push({ OR: [{ referenceType: null }, { referenceType: { notIn: SYSTEM_JOURNAL_TYPES } }] });
  }

  const from = query.startDate ? dayWindow(query.startDate, "startDate") : null;
  const to = query.endDate ? dayWindow(query.endDate, "endDate") : null;
  if (from && to && from.start > to.start) throw new AppError("Start date cannot be after end date.");
  if (from || to) where.date = { ...(from ? { gte: from.start } : {}), ...(to ? { lt: to.end } : {}) };

  const q = cleanString(query.search, 100);
  if (q) {
    and.push({
      OR: [
        { voucherNo: { contains: q, mode: "insensitive" } },
        { partyName: { contains: q, mode: "insensitive" } },
        { partyPhone: { contains: q, mode: "insensitive" } },
        { referenceDocNo: { contains: q, mode: "insensitive" } },
        { narration: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  if (and.length) where.AND = and;

  const [total, vouchers] = await Promise.all([
    prisma.voucher.count({ where }),
    prisma.voucher.findMany({
      where,
      include: {
        entries: true,
        sale: { select: { id: true, invoiceNo: true, dueAmount: true } },
        purchase: { select: { id: true, invoiceNo: true, dueAmount: true } },
        advanceReceive: {
          select: {
            id: true,
            amount: true,
            adjustedAmount: true,
            balanceAmount: true,
            status: true,
            receiveDate: true,
            paymentMode: true,
            specification: true,
            saleAdjustments: {
              include: { sale: { select: { id: true, invoiceNo: true, saleDate: true, netPayable: true } } },
              orderBy: { id: "desc" },
            },
          },
        },
      },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      skip,
      take: limit,
    }),
  ]);

  return { vouchers, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
};

export const getVoucherByIdService = async (voucherId, storeId) => {
  const sid = requireStoreId(storeId);
  const id = parseId(voucherId, "voucher id");
  const voucher = await prisma.voucher.findFirst({
    where: { id, storeId: sid },
    include: {
      entries: { orderBy: { id: "asc" } },
      sale: true,
      purchase: true,
      customer: true,
      party: true,
      advanceReceive: true,
      store: { select: publicStoreSelect },
    },
  });
  if (!voucher) throw new AppError("Voucher not found.", 404);
  return voucher;
};

export const getAccountingSummaryService = async (storeId) => {
  const sid = requireStoreId(storeId);
  const today = todayWindow();
  const month = monthWindow();
  const sumVouchers = (voucherType, w) =>
    prisma.voucher.aggregate({
      _sum: { amount: true },
      where: { storeId: sid, voucherType, status: "COMPLETED", date: { gte: w.start, lt: w.end } },
    });

  const [todayReceipts, monthReceipts, todayPayments, monthPayments, pendingSales, pendingPurchases, totalVouchersCount, availableAdvances] =
    await Promise.all([
      sumVouchers("RECEIPT", today),
      sumVouchers("RECEIPT", month),
      sumVouchers("PAYMENT", today),
      sumVouchers("PAYMENT", month),
      prisma.sale.aggregate({
        _sum: { dueAmount: true },
        _count: { id: true },
        where: { storeId: sid, status: "COMPLETED", dueAmount: { gt: EPS } },
      }),
      prisma.purchase.aggregate({
        _sum: { dueAmount: true },
        _count: { id: true },
        where: { storeId: sid, dueAmount: { gt: EPS } },
      }),
      prisma.voucher.count({ where: { storeId: sid } }),
      prisma.advanceReceive.aggregate({
        _sum: { balanceAmount: true },
        _count: { id: true },
        where: { storeId: sid, status: { in: ["AVAILABLE", "PARTIALLY_ADJUSTED"] }, balanceAmount: { gt: EPS } },
      }),
    ]);

  return {
    todayReceipts: roundMoney(todayReceipts._sum.amount || 0),
    monthReceipts: roundMoney(monthReceipts._sum.amount || 0),
    todayPayments: roundMoney(todayPayments._sum.amount || 0),
    monthPayments: roundMoney(monthPayments._sum.amount || 0),
    totalCustomerDue: roundMoney(pendingSales._sum.dueAmount || 0),
    pendingSalesCount: pendingSales._count.id || 0,
    totalSupplierDue: roundMoney(pendingPurchases._sum.dueAmount || 0),
    pendingPurchasesCount: pendingPurchases._count.id || 0,
    totalAvailableAdvance: roundMoney(availableAdvances._sum.balanceAmount || 0),
    totalAvailableAdvancesCount: availableAdvances._count.id || 0,
    totalVouchersCount,
  };
};

export const getNextVoucherNumberPreviewService = async (type, storeId) => {
  const sid = requireStoreId(storeId);
  return peekNextVoucherNo(sid, type);
};
