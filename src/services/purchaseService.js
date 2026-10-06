import prisma from "../config/db.js";
import {
  createPurchaseRepo,
  getPurchasesByStore,
  getPurchasesByStoreAndPhone,
  getPurchaseByIdRepo,
  getPurchaseItemsByPurchaseIdRepo,
  getPurchasesPendingInventoryRepo,
  updatePurchaseRepo,
  deletePurchaseRepo,
  getPurchaseReportRepo,
  countPurchases
} from "../repositories/purchaseRepository.js";
import { generateInvoiceNo } from "../utils/purchaseCodeGenerator.js";
import { getOrCreateCustomerService } from "./customerService.js";
import { getReportDateRange } from "../utils/reportDateFilter.js";
import { AppError, roundMoney, cleanString, cleanUrl, cleanPhone, optionalId, toDate } from "../utils/validate.js";
import {
  assertPurchaseType,
  buildPurchaseItem,
  computePurchaseTotals,
  buildDirectPayments,
  isVoucherPayment,
  settlementFields,
  PURCHASE_TYPES,
  has,
} from "./purchase/purchaseCalc.js";
import { postPurchaseJournal, cancelPurchaseJournal } from "./purchase/purchaseLedger.js";

const purchaseError = (message, status = 400) => new AppError(message, status);

const TX_OPTIONS = { maxWait: 20000, timeout: 60000 };
const MAX_ITEMS = 200;

const buildPurchaseItemCode = (id) => `PITM-${String(id).padStart(4, "0")}`;

const sanitizePurchaseItem = (purchaseItem) => {
  const code = purchaseItem?.purchaseItemCode || buildPurchaseItemCode(purchaseItem.id);
  return {
    ...purchaseItem,
    purchaseItemCode: code,
    purchaseitemcode: code,
  };
};

const withPurchaseItemUnits = (purchase) => ({
  ...purchase,
  unit: "₹",
  weightUnit: "gm",
  items: Array.isArray(purchase?.items)
    ? purchase.items.map((item) => ({
        ...sanitizePurchaseItem(item),
        unit: "₹",
        weightUnit: "gm",
        grossWeightUnit: "gm",
        stoneWeightUnit: "gm",
        netWeightUnit: "gm",
        actualWeightUnit: "gm",
        balanceWeightUnit: "gm",
        rateUnit: "₹/gm",
        metalAmountUnit: "₹",
        stoneAmountUnit: "₹",
        otherAmountUnit: "₹",
        totalAmountUnit: "₹",
      }))
    : purchase?.items,
});

// Codes are written once at insert time, so GET requests never write (PUR-25).
const assignItemCodes = async (tx, purchaseId) => {
  const items = await tx.purchaseItem.findMany({ where: { purchaseId, purchaseItemCode: null }, select: { id: true } });
  for (const it of items) {
    await tx.purchaseItem.update({ where: { id: it.id }, data: { purchaseItemCode: buildPurchaseItemCode(it.id) } });
  }
};

/** Migrated documents (legacy archive): their amounts are backed by legacy vouchers. */
const isLegacyPurchase = (purchase) => !/^(PUR\/|INV-\d+$)/.test(String(purchase.invoiceNo || ""));

const loadOwnPurchase = async (id, storeId, client = prisma) => {
  const purchase = await getPurchaseByIdRepo(Number(id), client);
  if (!purchase || purchase.storeId !== Number(storeId)) throw purchaseError("Purchase record not found.", 404);
  return purchase;
};

const assertIdsInStore = async (delegate, ids, storeId, label) => {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await delegate.findMany({ where: { id: { in: unique }, storeId }, select: { id: true } });
  if (rows.length !== unique.length) throw purchaseError(`The selected ${label} is not linked to this store.`);
  return new Map(rows.map((r) => [r.id, r]));
};

/** Checks every master id belongs to the store (create and update, PUR-14) and fills product/metal/purity from the item master. */
const validateItemMasters = async (items, storeId) => {
  const itemIds = [...new Set(items.map((i) => i.itemId).filter(Boolean))];
  if (itemIds.length) {
    const masters = await prisma.item.findMany({
      where: { id: { in: itemIds }, storeId },
      select: { id: true, productId: true, purityId: true, product: { select: { metalId: true, purityId: true, gradeId: true } } },
    });
    if (masters.length !== itemIds.length) throw purchaseError("The selected item is not linked to this store.");
    const byId = new Map(masters.map((m) => [m.id, m]));
    for (const it of items) {
      const m = it.itemId ? byId.get(it.itemId) : null;
      if (!m) continue;
      it.productId = it.productId || m.productId || null;
      it.metalId = it.metalId || m.product?.metalId || null;
      it.purityId = it.purityId || m.purityId || m.product?.purityId || null;
      it.gradeId = it.gradeId || m.product?.gradeId || null;
    }
  }
  // Metal follows the purity when the product does not fix one (legacy products).
  const needMetal = [...new Set(items.filter((i) => !i.metalId && i.purityId).map((i) => i.purityId))];
  if (needMetal.length) {
    const purities = await prisma.purity.findMany({ where: { id: { in: needMetal }, storeId }, select: { id: true, metalId: true } });
    const metalOf = new Map(purities.map((p) => [p.id, p.metalId]));
    for (const it of items) if (!it.metalId && it.purityId) it.metalId = metalOf.get(it.purityId) || null;
  }
  await assertIdsInStore(prisma.product, items.map((i) => i.productId), storeId, "product");
  await assertIdsInStore(prisma.metal, items.map((i) => i.metalId), storeId, "metal");
  await assertIdsInStore(prisma.purity, items.map((i) => i.purityId), storeId, "purity");
  await assertIdsInStore(prisma.grade, items.map((i) => i.gradeId), storeId, "grade");
  await assertIdsInStore(prisma.stone, items.map((i) => i.stoneId), storeId, "stone");
};

const buildItems = async (rawItems, storeId) => {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw purchaseError("Please add at least one purchase item.");
  if (rawItems.length > MAX_ITEMS) throw purchaseError(`A purchase can have at most ${MAX_ITEMS} items.`);
  const items = rawItems.map((item, i) => buildPurchaseItem(item, i));
  await validateItemMasters(items, storeId);
  return items;
};

const resolveParty = async (partyId, storeId) => {
  if (!partyId) return null;
  const party = await prisma.partymaster.findFirst({ where: { id: partyId, storeId } });
  if (!party) throw purchaseError("The selected party is not linked to this store. Please choose a valid party.");
  return party;
};

const resolveEmployee = async (employeeId, storeId) => {
  if (!employeeId) return null;
  const employee = await prisma.employee.findFirst({ where: { id: employeeId, storeId }, select: { id: true } });
  if (!employee) throw purchaseError("The selected employee is not linked to this store. Please choose a valid employee.");
  return employee;
};

const validateSeller = ({ purchaseType, party, customerName, customerPhone }) => {
  if (customerPhone && customerPhone.length !== 10) throw purchaseError("Customer phone must be exactly 10 digits.");
  if (!party && purchaseType === "OLD" && (!customerName || !customerPhone)) {
    throw purchaseError("Please enter customer name and a 10-digit phone for a walk-in old gold purchase.");
  }
};

const storeState = async (storeId) => {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { state: true } });
  if (!store) throw purchaseError("Store not found.", 404);
  return store.state;
};

const sumAmounts = (rows) => roundMoney(rows.reduce((s, p) => s + Number(p.amount || 0), 0));

const assertPaidWithinNet = (paid, net) => {
  if (paid > net + 0.01) {
    throw purchaseError(`Paid amount (${paid.toFixed(2)}) cannot exceed total amount (${net.toFixed(2)}).`);
  }
};

const resolveCustomerId = async (tx, { customerName, customerPhone, address, customerIdType, customerIdNumber }, storeId) => {
  if (!customerPhone) return null;
  const customer = await getOrCreateCustomerService(
    { customerName, customerPhone, customerAddress: address, customerIdType, customerIdNumber },
    storeId,
    tx
  );
  return customer?.id || null;
};

/**
 * `options.isOpeningStock` marks stock already owned (Stock Entry "opening / own stock"): no seller,
 * no money, no ledger. `options.onCreated(tx, purchase)` runs inside the same transaction (Stock
 * Entry tags every line there, so a purchase never exists without its pieces).
 */
export const createPurchase = async (data, storeId, options = {}) => {
  const { isOpeningStock = false, onCreated = null } = options;
  const numericStoreId = Number(storeId);
  if (!numericStoreId) throw purchaseError("Please select a store before creating a purchase.");
  if (!data || typeof data !== "object") throw purchaseError("Invalid purchase data.");

  const purchaseType = assertPurchaseType(data.purchaseType);
  const items = await buildItems(data.items, numericStoreId);

  const party = await resolveParty(optionalId(data.partyId, "party"), numericStoreId);
  const employee = await resolveEmployee(optionalId(data.employeeId, "employee"), numericStoreId);
  const customerName = cleanString(data.customerName, 150);
  const customerPhone = cleanPhone(data.customerPhone);
  validateSeller({ purchaseType, party, customerName, customerPhone });

  const date = toDate(data.date, { field: "Purchase date" });
  const totals = computePurchaseTotals({
    items,
    purchaseType,
    discount: data.discount,
    applyGst: data.applyGst,
    isRCM: data.isRCM === true || data.isRCM === "true",
    placeOfSupply: data.placeOfSupply,
    storeState: await storeState(numericStoreId),
    roundOff: data.roundOff,
  });

  const rawPayments = Array.isArray(data.payments) && data.payments.length > 0
    ? data.payments
    : Number(data.paidAmount || 0) > 0
      ? [{ paymentMode: data.paymentMode || "CASH", amount: data.paidAmount }]
      : [];
  const payments = buildDirectPayments(rawPayments, numericStoreId);
  const totalPaid = sumAmounts(payments);
  assertPaidWithinNet(totalPaid, totals.netPayable);

  const header = {
    purchaseType,
    isOpeningStock: Boolean(isOpeningStock),
    partyId: party?.id ?? null,
    employeeId: employee?.id ?? null,
    storeId: numericStoreId,
    date,
    referenceNo: cleanString(data.referenceNo, 100),
    referenceDate: data.referenceDate ? toDate(data.referenceDate, { field: "Reference date" }) : null,
    address: cleanString(data.address, 500),
    placeOfSupply: cleanString(data.placeOfSupply, 100),
    customerName,
    customerPhone: customerPhone || null,
    customerIdType: cleanString(data.customerIdType, 50),
    customerIdNumber: cleanString(data.customerIdNumber, 50),
    document: cleanUrl(data.document, "Document"),
    attachments: data.attachments && typeof data.attachments === "object" ? data.attachments : undefined,
    grossAmount: totals.grossAmount,
    taxableAmount: totals.taxableAmount,
    subtotal: totals.subtotal,
    discount: totals.discount,
    igst: totals.igst,
    cgst: totals.cgst,
    sgst: totals.sgst,
    taxAmount: totals.taxAmount,
    isRCM: totals.isRCM,
    roundOff: totals.roundOff,
    totalAmount: totals.totalAmount,
    netPayable: totals.netPayable,
    paymentMode: payments[0]?.paymentMode ?? (cleanString(data.paymentMode, 30) || null),
    ...settlementFields({ purchaseType, netPayable: totals.netPayable, paidAmount: totalPaid, adjustedAmount: 0 }),
    narration: cleanString(data.narration, 1000),
  };

  const created = await prisma.$transaction(async (tx) => {
    const customerId = await resolveCustomerId(tx, { ...header, customerPhone }, numericStoreId);
    const invoiceNo = await generateInvoiceNo(numericStoreId, tx, date);
    const purchase = await createPurchaseRepo(
      {
        ...header,
        invoiceNo,
        customerId,
        items: { create: items },
        payments: { create: payments },
      },
      tx
    );
    await assignItemCodes(tx, purchase.id);
    if (!isOpeningStock) await postPurchaseJournal(tx, purchase, { party, directPayments: purchase.payments });
    const full = await getPurchaseByIdRepo(purchase.id, tx);
    const extra = onCreated ? await onCreated(tx, full) : undefined;
    return { full, extra };
  }, TX_OPTIONS);

  const result = { ...withPurchaseItemUnits(created.full), gstType: totals.gstType };
  if (created.extra !== undefined) result.stockEntry = created.extra;
  return result;
};

export const getPurchases = async (storeId, options = {}) => {
  if (options.purchaseType && !PURCHASE_TYPES.includes(options.purchaseType)) {
    throw purchaseError("Please choose a valid purchase type (ORNAMENT, OLD or BULLION).");
  }
  const result = await getPurchasesByStore(Number(storeId), options);
  if (options.paginated) return {
    purchases: result.purchases.map(withPurchaseItemUnits),
    total: result.total,
  };
  return result.map(withPurchaseItemUnits);
};

export const getPurchaseById = async (id, storeId) => {
  return withPurchaseItemUnits(await loadOwnPurchase(id, storeId));
};

export const getPurchaseItemsByPurchaseId = async (purchaseId, storeId, { withoutInventory = false } = {}) => {
  await loadOwnPurchase(purchaseId, storeId);
  const purchaseItems = await getPurchaseItemsByPurchaseIdRepo(Number(purchaseId), Number(storeId), { withoutInventory });
  return purchaseItems.map(sanitizePurchaseItem);
};

/** Purchases (with their un-tagged lines) for the "Add Inventory" picker. */
export const getPurchasesPendingInventory = async (storeId, { purchaseType, search } = {}) => {
  const type = purchaseType && purchaseType !== "ALL" ? assertPurchaseType(purchaseType) : undefined;
  const rows = await getPurchasesPendingInventoryRepo(Number(storeId), { purchaseType: type, search });
  return rows.map((p) => ({ ...p, items: p.items.map(sanitizePurchaseItem) }));
};

/** Blocks edit/delete of purchases that other documents depend on (rule 1, PUR-04). */
const assertNotUsedDownstream = async (purchase, action) => {
  if (await prisma.inventory.findFirst({ where: { purchaseId: purchase.id }, select: { id: true } })) {
    throw purchaseError(`This purchase has already been added to inventory and cannot be ${action}.`);
  }
  if (Number(purchase.adjustedAmount || 0) > 0.001) {
    throw purchaseError(`This old gold purchase has already been adjusted in a sale and cannot be ${action}.`);
  }
  if (await prisma.saleOldGold.findFirst({ where: { purchaseId: purchase.id }, select: { id: true } })) {
    throw purchaseError(`This old gold purchase is linked to a sale and cannot be ${action}.`);
  }
};

const FINANCIAL_KEYS = ["items", "payments", "purchaseType", "discount", "roundOff", "placeOfSupply", "isRCM", "applyGst", "partyId"];

export const updatePurchase = async (id, data, storeId) => {
  const numericStoreId = Number(storeId);
  if (!data || typeof data !== "object") throw purchaseError("Invalid purchase data.");
  const purchase = await loadOwnPurchase(id, numericStoreId);
  await assertNotUsedDownstream(purchase, "edited");

  const legacy = isLegacyPurchase(purchase);
  if (legacy && FINANCIAL_KEYS.some((k) => has(data, k))) {
    throw purchaseError("This is a migrated (legacy) purchase. Only its details (reference, address, customer KYC, narration) can be edited; items, amounts and payments are locked.");
  }

  const pick = (key, current) => (has(data, key) ? data[key] : current);

  const purchaseType = assertPurchaseType(pick("purchaseType", purchase.purchaseType));
  const itemsChanged = has(data, "items");
  const items = itemsChanged ? await buildItems(data.items, numericStoreId) : null;

  // PUR-15: a replaced line keeps its existing photo unless a new one was uploaded.
  if (items) {
    const oldById = new Map(purchase.items.map((it) => [it.id, it]));
    data.items.forEach((raw, i) => {
      const prevId = Number(raw?.id || raw?.purchaseItemId);
      const prev = prevId ? oldById.get(prevId) : null;
      if (!items[i].itemPhoto && prev?.itemPhoto) items[i].itemPhoto = prev.itemPhoto;
    });
  }

  const partyId = has(data, "partyId") ? optionalId(data.partyId, "party") : purchase.partyId;
  const party = await resolveParty(partyId, numericStoreId);
  const employeeId = has(data, "employeeId") ? optionalId(data.employeeId, "employee") : purchase.employeeId;
  await resolveEmployee(employeeId, numericStoreId);

  const customerName = cleanString(pick("customerName", purchase.customerName), 150);
  const customerPhone = cleanPhone(pick("customerPhone", purchase.customerPhone));
  if (!legacy) validateSeller({ purchaseType, party, customerName, customerPhone });
  else if (has(data, "customerPhone") && customerPhone && customerPhone.length !== 10) {
    throw purchaseError("Customer phone must be exactly 10 digits.");
  }

  const header = {
    purchaseType,
    partyId: party?.id ?? null,
    employeeId: employeeId || null,
    date: has(data, "date") ? toDate(data.date, { field: "Purchase date" }) : purchase.date,
    referenceNo: cleanString(pick("referenceNo", purchase.referenceNo), 100),
    referenceDate: has(data, "referenceDate")
      ? (data.referenceDate ? toDate(data.referenceDate, { field: "Reference date" }) : null)
      : purchase.referenceDate,
    address: cleanString(pick("address", purchase.address), 500),
    placeOfSupply: cleanString(pick("placeOfSupply", purchase.placeOfSupply), 100),
    customerName,
    customerPhone: customerPhone || null,
    customerIdType: cleanString(pick("customerIdType", purchase.customerIdType), 50),
    customerIdNumber: cleanString(pick("customerIdNumber", purchase.customerIdNumber), 50),
    document: cleanUrl(pick("document", purchase.document), "Document"),
    attachments: has(data, "attachments") && data.attachments && typeof data.attachments === "object" ? data.attachments : undefined,
    narration: cleanString(pick("narration", purchase.narration), 1000),
  };

  const voucherPayments = purchase.payments.filter(isVoucherPayment);
  const oldDirectPayments = purchase.payments.filter((p) => !isVoucherPayment(p));
  const paymentsChanged = has(data, "payments") && Array.isArray(data.payments);

  let financial = {};
  let revaluedItems = null;
  let directPayments = oldDirectPayments;
  let gstType;
  if (!legacy) {
    // Keep the existing GST choice unless the client changes it (or the type changes).
    let applyGst = data.applyGst;
    if (!has(data, "applyGst") && purchaseType === purchase.purchaseType && Number(purchase.taxableAmount) > 0) {
      applyGst = Number(purchase.taxAmount) > 0;
    }
    // Unchanged lines are re-valued too, so stored line totals always match the header.
    if (!items) revaluedItems = purchase.items.map((it, i) => ({ id: it.id, ...buildPurchaseItem(it, i) }));
    const totals = computePurchaseTotals({
      items: items || revaluedItems,
      purchaseType,
      discount: pick("discount", purchase.discount),
      applyGst,
      isRCM: has(data, "isRCM") ? data.isRCM === true || data.isRCM === "true" : purchase.isRCM,
      placeOfSupply: header.placeOfSupply,
      storeState: await storeState(numericStoreId),
      roundOff: has(data, "roundOff") ? data.roundOff : undefined,
    });
    gstType = totals.gstType;

    // Client paid/due values are ignored (PUR-20); voucher payments are never replaced (PUR-05).
    if (paymentsChanged) {
      directPayments = buildDirectPayments(data.payments.filter((p) => !isVoucherPayment(p)), numericStoreId);
    }
    const totalPaid = roundMoney(sumAmounts(voucherPayments) + sumAmounts(directPayments));
    assertPaidWithinNet(totalPaid, totals.netPayable);

    const { gstType: _ignored, ...totalFields } = totals;
    financial = {
      ...totalFields,
      paymentMode: (paymentsChanged ? directPayments[0]?.paymentMode : null) || purchase.paymentMode,
      ...settlementFields({ purchaseType, netPayable: totals.netPayable, paidAmount: totalPaid, adjustedAmount: 0 }),
    };
  }

  const phoneChanged = (customerPhone || null) !== (cleanPhone(purchase.customerPhone) || null);

  const updated = await prisma.$transaction(async (tx) => {
    let customerId = purchase.customerId;
    if (phoneChanged || (customerPhone && !customerId)) {
      customerId = await resolveCustomerId(tx, { ...header, customerPhone }, numericStoreId);
    }

    // Conditional write: fails if a sale adjusted this purchase after we read it.
    const guard = await tx.purchase.updateMany({
      where: { id: purchase.id, storeId: numericStoreId, adjustedAmount: { lte: 0.001 } },
      data: { ...header, ...financial, customerId: customerPhone ? customerId : null },
    });
    if (guard.count === 0) throw purchaseError("This purchase was changed by another transaction. Please reload and try again.", 409);
    if (await tx.inventory.findFirst({ where: { purchaseId: purchase.id }, select: { id: true } })) {
      throw purchaseError("This purchase has already been added to inventory and cannot be edited.");
    }

    if (items) {
      await tx.purchaseItem.deleteMany({ where: { purchaseId: purchase.id } });
      await tx.purchaseItem.createMany({ data: items.map((it) => ({ ...it, purchaseId: purchase.id })) });
      await assignItemCodes(tx, purchase.id);
    } else if (revaluedItems) {
      for (const { id: itemId, ...it } of revaluedItems) {
        await tx.purchaseItem.update({
          where: { id: itemId },
          data: {
            netWeight: it.netWeight, pureWeight: it.pureWeight, metalAmount: it.metalAmount, totalAmount: it.totalAmount,
            pieces: it.pieces, rate: it.rate,
          },
        });
      }
    }

    if (!legacy && paymentsChanged) {
      if (oldDirectPayments.length) {
        await tx.purchasePayment.deleteMany({ where: { id: { in: oldDirectPayments.map((p) => p.id) }, purchaseId: purchase.id } });
      }
      if (directPayments.length) {
        await tx.purchasePayment.createMany({ data: directPayments.map((p) => ({ ...p, purchaseId: purchase.id })) });
      }
    }

    if (!legacy) {
      const fresh = await getPurchaseByIdRepo(purchase.id, tx);
      await cancelPurchaseJournal(tx, fresh, "Purchase updated - re-posted");
      if (!fresh.isOpeningStock) await postPurchaseJournal(tx, fresh, { party, directPayments: fresh.payments.filter((p) => !isVoucherPayment(p)) });
    }
    return getPurchaseByIdRepo(purchase.id, tx);
  }, TX_OPTIONS);

  return { ...withPurchaseItemUnits(updated), ...(gstType ? { gstType } : {}) };
};

export const deletePurchase = async (id, storeId) => {
  const purchase = await loadOwnPurchase(id, storeId);
  await assertNotUsedDownstream(purchase, "deleted");

  if (isLegacyPurchase(purchase)) {
    throw purchaseError("This is a migrated (legacy) purchase and cannot be deleted.");
  }
  if (purchase.payments.some(isVoucherPayment)) {
    throw purchaseError("This purchase has payment vouchers. Cancel the payment vouchers first, then delete the purchase.");
  }
  const otherVoucher = await prisma.voucher.findFirst({
    where: { purchaseId: purchase.id, status: "COMPLETED", NOT: { voucherType: "JOURNAL", referenceType: "PURCHASE" } },
    select: { voucherNo: true },
  });
  if (otherVoucher) {
    throw purchaseError(`Voucher ${otherVoucher.voucherNo} is linked to this purchase. Cancel it first, then delete the purchase.`);
  }

  return prisma.$transaction(async (tx) => {
    await cancelPurchaseJournal(tx, purchase, "Purchase deleted");
    return deletePurchaseRepo(purchase.id, tx);
  }, TX_OPTIONS);
};

export const getPurchaseCount = async (storeId) => {
  return await countPurchases(Number(storeId));
};

export const getOldGoldPurchasesByPhoneService = async (
  storeId,
  phone
) => {
  const numericStoreId = Number(storeId);
  const customerPhone = cleanPhone(phone);

  if (!numericStoreId) {
    throw purchaseError("Please select a store before viewing old gold purchases.");
  }

  if (customerPhone.length !== 10) {
    throw purchaseError("Please enter a 10-digit customer phone number.");
  }

  const rows = await getPurchasesByStoreAndPhone(numericStoreId, customerPhone);
  // Adjustable value under rule 1 is the balance (net - paid - adjusted).
  return rows.map((p) => ({ ...withPurchaseItemUnits(p), availableAmount: roundMoney(p.balanceAmount) }));
};

const REPORT_TYPES = ["ALL", ...PURCHASE_TYPES];

export const getPurchaseReportService = async ({
  storeId,
  period = "THIS_MONTH",
  fromDate,
  toDate,
  purchaseType = "ALL",
}) => {
  const numericStoreId = Number(storeId);
  if (!numericStoreId) throw purchaseError("Please select a store.");
  const type = String(purchaseType || "ALL").trim().toUpperCase();
  if (!REPORT_TYPES.includes(type)) throw purchaseError("Please choose a valid purchase type (ALL, ORNAMENT, OLD or BULLION).");

  const dateRange = getReportDateRange(
    period,
    fromDate,
    toDate
  );

  const rows =
    await getPurchaseReportRepo(
      numericStoreId,
      dateRange.fromDate,
      dateRange.toDate,
      type
    );

  // RPT-02: "Balance" in the report is the amount still owed (dueAmount). The old-gold
  // unadjusted value is kept separately as oldGoldBalance.
  const purchases = rows.map((p) => ({
    ...p,
    oldGoldBalance: p.purchaseType === "OLD" ? p.balanceAmount : null,
    balanceAmount: p.dueAmount,
  }));

  const summary = purchases.reduce(
    (acc, purchase) => {
      acc.totalBills += 1;
      acc.totalInvoices += 1;

      acc.totalItems +=
        purchase.items?.length || 0;

      const amount = Number(
        purchase.netPayable ||
        purchase.totalAmount ||
        purchase.grossAmount ||
        0
      );

      acc.totalPurchase += amount;
      acc.netPurchase += amount;
      acc.totalAmount += amount;

      const gross = Number(purchase.grossAmount || amount);
      acc.grossAmount += gross;

      const paid = Number(purchase.paidAmount || 0);
      acc.paidAmount += paid;

      const due = Number(purchase.dueAmount || 0);
      acc.balanceAmount += due;
      acc.dueAmount += due;

      if (
        purchase.purchaseType === "ORNAMENT"
      ) {
        acc.ornamentPurchase += amount;
      } else if (
        purchase.purchaseType === "OLD"
      ) {
        acc.oldPurchase += amount;
      } else if (
        purchase.purchaseType === "BULLION"
      ) {
        acc.bullionPurchase += amount;
      }

      return acc;
    },
    {
      totalBills: 0,
      totalInvoices: 0,
      totalItems: 0,
      totalPurchase: 0,
      netPurchase: 0,
      totalAmount: 0,
      grossAmount: 0,
      paidAmount: 0,
      balanceAmount: 0,
      dueAmount: 0,
      ornamentPurchase: 0,
      oldPurchase: 0,
      bullionPurchase: 0,
    }
  );

  for (const k of Object.keys(summary)) {
    if (!["totalBills", "totalInvoices", "totalItems"].includes(k)) summary[k] = roundMoney(summary[k]);
  }

  return {
    filter: {
      period,
      purchaseType: type,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
    },

    summary,

    purchases,
  };
};
