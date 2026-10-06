import prisma from "../config/db.js";
import {
  createSaleRepo,
  getSaleByIdRepo,
  getSalesRepo,
  getSaleCountRepo,
  getSalesReportRepo,
} from "../repositories/salesRepository.js";
import { getOrCreateCustomerService } from "./customerService.js";
import { createCustomerAdjustmentLogRepo } from "../repositories/customerRepository.js";
import { generateSaleInvoiceNo } from "../utils/salesCodeGenerator.js";
import { numberToWordsIndian } from "../utils/numberToWords.js";
import { getReportDateRange } from "../utils/reportDateFilter.js";
import {
  AppError,
  toNumber,
  toMoney,
  parseId,
  optionalId,
  toDate,
  cleanString,
  cleanPhone,
  roundMoney,
  roundWeight,
} from "../utils/validate.js";
import { cancelVoucherAtomic } from "../utils/ledger.js";
import {
  USABLE_ADVANCE_STATUSES,
  belongsToCustomer,
  advanceAvailable,
  oldGoldAdjustable,
  oldGoldValuation,
} from "./sales/balances.js";
import { postSaleJournal, saleJournalNo } from "./sales/saleLedger.js";

const PAYMENT_MODES = ["CASH", "ONLINE", "CARD", "UPI", "CHEQUE", "OTHER"];
const MAKING_TYPES = { PERCENT: "PERCENT", PER_GRAM: "PER_GRAM", FLAT: "FLAT", FIXED: "FLAT", AMOUNT: "FLAT" };
const MAX_LINES = 200;
const MAX_AMOUNT = 1e9;
const MAX_RATE = 1e7;

// GST on jewellery (HSN 7113): intra-state CGST 1.5% + SGST 1.5%, inter-state IGST 3%.
const GST = { CGST: 1.5, SGST: 1.5, IGST: 3 };

const formatMoney = (value) => roundMoney(value).toFixed(2);

const withSaleItemUnits = (sale) => ({
  ...sale,
  unit: "₹",
  weightUnit: "gm",
  items: Array.isArray(sale?.items)
    ? sale.items.map((item) => ({
        ...item,
        unit: "₹",
        weightUnit: "gm",
        rateUnit: "₹/gm",
        makingChargeUnit: item?.makingChargeType === "PER_GRAM" ? "₹/gm" : item?.makingChargeType === "PERCENT" ? "%" : "₹",
        grossWeightUnit: "gm",
        stoneWeightUnit: "gm",
        netWeightUnit: "gm",
        metalAmountUnit: "₹",
        makingChargesUnit: "₹",
        stoneAmountUnit: "₹",
        otherChargesUnit: "₹",
        totalAmountUnit: "₹",
      }))
    : sale?.items,
});

const requireStoreId = (storeId) => {
  const sid = Number(storeId);
  if (!Number.isInteger(sid) || sid <= 0) throw new AppError("Please select a store.");
  return sid;
};

/** A date-only value for today keeps the current time (so the invoice shows the real billing time). */
const parseSaleDate = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return new Date();
  const raw = String(value).trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    const now = new Date();
    const date = now.getFullYear() === y && now.getMonth() === mo && now.getDate() === d ? now : new Date(y, mo, d, 12, 0, 0);
    if (date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d) throw new AppError("Sale date is not a valid date.");
    return toDate(date, { field: "Sale date" });
  }
  return toDate(raw, { field: "Sale date" });
};

/** Parses and validates one item line from the client (amounts only; weights come from stock). */
const parseLine = (item, index) => {
  const n = index + 1;
  if (!item || typeof item !== "object") throw new AppError(`Line ${n} is invalid.`);
  const typeKey = String(item.makingChargeType || "PERCENT").trim().toUpperCase();
  const makingChargeType = MAKING_TYPES[typeKey];
  if (!makingChargeType) throw new AppError(`Line ${n}: making charge type "${item.makingChargeType}" is not supported.`);
  return {
    inventoryId: parseId(item.inventoryId, `inventory item on line ${n}`),
    rate: toMoney(item.rate, { field: `Line ${n} rate`, max: MAX_RATE }),
    makingChargeType,
    makingChargeRate: toNumber(item.makingChargeRate ?? item.makingChargePercent, {
      field: `Line ${n} making charge`,
      max: makingChargeType === "PERCENT" ? 100 : MAX_AMOUNT,
    }),
    makingChargesInput: toMoney(item.makingCharges, { field: `Line ${n} making charges`, max: MAX_AMOUNT }),
    stoneAmount: toMoney(item.stoneAmount, { field: `Line ${n} stone amount`, max: MAX_AMOUNT }),
    hallmarkCharges: toMoney(item.hallmarkCharges, { field: `Line ${n} hallmark charges`, max: 1e6 }),
    otherCharges: toMoney(item.otherCharges ?? item.otherAmount, { field: `Line ${n} other charges`, max: MAX_AMOUNT }),
    discount: toMoney(item.discount, { field: `Line ${n} discount`, max: MAX_AMOUNT }),
    particulars: cleanString(item.particulars, 200),
    itemCode: cleanString(item.itemCode, 100),
    huidNo: cleanString(item.huidNo, 50),
    hsnCode: cleanString(item.hsnCode, 20),
    purityName: cleanString(item.purityName, 50),
  };
};

const parseAdjustments = (list, { idKeys, label }) => {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new AppError(`${label} adjustments must be a list.`);
  const seen = new Set();
  const out = [];
  for (const adj of list) {
    if (!adj || typeof adj !== "object") throw new AppError(`${label} adjustment is invalid.`);
    const rawId = idKeys.map((k) => adj?.[k]).find((v) => v !== undefined && v !== null && v !== "");
    const id = parseId(rawId, `${label.toLowerCase()} reference`);
    const amount = toMoney(adj.amount ?? adj.adjustedAmount ?? adj.value, { field: `${label} adjustment amount`, max: MAX_AMOUNT });
    if (seen.has(id)) throw new AppError(`${label} #${id} is listed more than once in this sale.`);
    seen.add(id);
    if (amount <= 0) continue;
    out.push({ id, amount, description: cleanString(adj.description, 200), notes: cleanString(adj.notes, 500) });
  }
  return out;
};

const parsePayments = (list) => {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new AppError("Payments must be a list.");
  const out = [];
  for (const payment of list) {
    if (!payment || typeof payment !== "object") throw new AppError("Payment line is invalid.");
    const mode = String(payment?.paymentMode || "CASH").trim().toUpperCase();
    if (!PAYMENT_MODES.includes(mode)) throw new AppError(`Payment mode "${payment?.paymentMode}" is not supported.`);
    const amount = toMoney(payment.amount, { field: "Payment amount", max: MAX_AMOUNT });
    if (amount <= 0) continue;
    const ref = cleanString(payment.referenceNo || payment.transactionId, 100);
    out.push({
      paymentMode: mode,
      amount,
      paymentChannel: cleanString(payment.paymentChannel, 100),
      transactionId: cleanString(payment.transactionId || payment.referenceNo, 100),
      referenceNo: ref,
      paymentDate: toDate(payment.paymentDate, { field: "Payment date" }),
      description: cleanString(payment.description || payment.narration, 500),
      narration: cleanString(payment.narration || payment.description, 500),
    });
  }
  return out;
};

const pieceCode = (inv) => inv.barcodeNo || inv.tagNo || inv.inventoryCode || `#${inv.id}`;

/**
 * Claims every piece AVAILABLE -> SOLD with a conditional update before anything else is written.
 * Row locks taken here make a concurrent sale of the same piece wait and then fail (count 0).
 * Ids are processed in ascending order so two multi-item sales never deadlock.
 */
const claimInventory = async (tx, inventoryIds, storeId) => {
  for (const id of [...inventoryIds].sort((a, b) => a - b)) {
    const claimed = await tx.inventory.updateMany({
      where: { id, storeId, status: "AVAILABLE", purchaseType: { not: "OLD" } },
      data: { status: "SOLD" },
    });
    if (claimed.count === 1) continue;

    const inv = await tx.inventory.findFirst({
      where: { id, storeId },
      select: { id: true, status: true, purchaseType: true, barcodeNo: true, tagNo: true, inventoryCode: true },
    });
    if (!inv) throw new AppError("Selected inventory item was not found in this store. Please refresh the page and try again.", 404);
    if (inv.purchaseType === "OLD") {
      throw new AppError(`Item "${pieceCode(inv)}" is old / scrap gold bought from a customer and cannot be billed as stock.`);
    }
    if (inv.status === "AVAILABLE") throw new AppError(`Item "${pieceCode(inv)}" was just billed at another counter. Please refresh.`, 409);
    throw new AppError(`Inventory item "${pieceCode(inv)}" is already ${inv.status.toLowerCase()} and cannot be sold.`, 409);
  }
};

/** Line amounts, all server-side. Weights and pieces come from the inventory record. */
const buildSaleLine = (line, inventory, index) => {
  const grossWeight = roundWeight(inventory.grossWeight);
  const stoneWeight = roundWeight(inventory.stoneWeight);
  const netWeight = roundWeight(inventory.netWeight ?? Math.max(0, grossWeight - stoneWeight));
  const pieces = Math.max(1, Number.parseInt(inventory.pieces, 10) || 1);

  const metalAmount = roundMoney(netWeight * line.rate);
  let makingCharges;
  if (line.makingChargesInput > 0 && line.makingChargeRate === 0) {
    makingCharges = line.makingChargesInput;
  } else if (line.makingChargeType === "PERCENT") {
    makingCharges = roundMoney((metalAmount * line.makingChargeRate) / 100);
  } else if (line.makingChargeType === "PER_GRAM") {
    makingCharges = roundMoney(netWeight * line.makingChargeRate);
  } else {
    makingCharges = roundMoney(line.makingChargesInput || line.makingChargeRate);
  }

  const lineValue = roundMoney(metalAmount + makingCharges + line.stoneAmount + line.hallmarkCharges + line.otherCharges);
  if (line.discount > lineValue + 0.01) {
    throw new AppError(`Line ${index + 1}: discount (${formatMoney(line.discount)}) cannot exceed the item value (${formatMoney(lineValue)}).`);
  }
  const totalAmount = roundMoney(lineValue - line.discount);
  if (totalAmount <= 0) throw new AppError(`Line ${index + 1} (${pieceCode(inventory)}) has no value. Please enter the rate.`);

  return {
    inventoryId: inventory.id,
    particulars: line.particulars || inventory.item?.name || inventory.product?.name || "Jewellery Item",
    itemCode: line.itemCode || inventory.barcodeNo || inventory.tagNo || inventory.inventoryCode || "",
    huidNo: inventory.huidNo || line.huidNo || null,
    hsnCode: inventory.hsnCode || line.hsnCode || "711319",
    purityName: inventory.purityMaster?.name || line.purityName || (inventory.purity ? `${inventory.purity}K` : null),
    pieces,
    grossWeight,
    stoneWeight,
    netWeight,
    purity: inventory.purity ?? null,
    rate: line.rate,
    metalAmount,
    makingCharges,
    makingChargeType: line.makingChargeType,
    makingChargeRate: line.makingChargeRate,
    stoneAmount: line.stoneAmount,
    hallmarkCharges: line.hallmarkCharges,
    otherCharges: line.otherCharges,
    otherAmount: line.otherCharges,
    discount: line.discount,
    taxableAmount: totalAmount,
    totalAmount,
    cgst: 0,
    sgst: 0,
    igst: 0,
    taxAmount: 0,
  };
};

/** Spreads invoice-level discount and GST over lines; rounding residue goes to the last line. */
const allocateLineTax = (lines, { grossAmount, taxableAmount, cgstAmount, sgstAmount, igstAmount }) => {
  const ratio = grossAmount > 0 ? taxableAmount / grossAmount : 0;
  const totals = { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
  lines.forEach((line, i) => {
    const last = i === lines.length - 1;
    const share = (value, key, base) => (last ? roundMoney(value - totals[key]) : roundMoney(base));
    line.taxableAmount = share(taxableAmount, "taxable", line.totalAmount * ratio);
    const lineRatio = taxableAmount > 0 ? line.taxableAmount / taxableAmount : 0;
    line.cgst = share(cgstAmount, "cgst", cgstAmount * lineRatio);
    line.sgst = share(sgstAmount, "sgst", sgstAmount * lineRatio);
    line.igst = share(igstAmount, "igst", igstAmount * lineRatio);
    line.taxAmount = roundMoney(line.cgst + line.sgst + line.igst);
    totals.taxable = roundMoney(totals.taxable + line.taxableAmount);
    totals.cgst = roundMoney(totals.cgst + line.cgst);
    totals.sgst = roundMoney(totals.sgst + line.sgst);
    totals.igst = roundMoney(totals.igst + line.igst);
  });
};

/** Consumes an advance with an atomic conditional update (BRIEF rule 2). */
const applyAdvance = async (tx, adj, ctx) => {
  const advance = await tx.advanceReceive.findFirst({
    where: { id: adj.id, storeId: ctx.storeId },
    include: { saleAdjustments: { include: { sale: { select: { status: true } } } } },
  });
  if (!advance) throw new AppError(`Advance receipt ADV-${adj.id} was not found in this store.`, 404);
  if (!belongsToCustomer({ ownerCustomerId: advance.customerId, ownerPhone: advance.contactNumber }, ctx.customer)) {
    throw new AppError(`Advance ADV-${advance.id} belongs to another customer and cannot be used on this bill.`);
  }
  if (advance.status === "CANCELLED") throw new AppError(`Advance ADV-${advance.id} has been cancelled / refunded and cannot be used.`);
  if (!USABLE_ADVANCE_STATUSES.includes(advance.status)) throw new AppError(`Advance ADV-${advance.id} has already been fully used.`);

  const available = advanceAvailable(advance);
  if (adj.amount > available + 0.01) {
    throw new AppError(
      `Requested advance adjustment (Rs. ${formatMoney(adj.amount)}) exceeds the available balance (Rs. ${formatMoney(available)}) of ADV-${advance.id}.`
    );
  }

  const res = await tx.advanceReceive.updateMany({
    where: { id: advance.id, storeId: ctx.storeId, status: { in: USABLE_ADVANCE_STATUSES }, balanceAmount: { gte: adj.amount - 0.01 } },
    data: { adjustedAmount: { increment: adj.amount }, balanceAmount: { decrement: adj.amount } },
  });
  if (res.count === 0) throw new AppError(`Advance ADV-${advance.id} was just used on another bill. Please refresh and try again.`, 409);

  const after = await tx.advanceReceive.findUnique({ where: { id: advance.id }, select: { balanceAmount: true } });
  const remainingBalance = roundMoney(Math.max(0, after.balanceAmount));
  await tx.advanceReceive.update({
    where: { id: advance.id },
    data: { balanceAmount: remainingBalance, status: remainingBalance <= 0.01 ? "FULLY_ADJUSTED" : "PARTIALLY_ADJUSTED" },
  });

  return {
    advance,
    amount: adj.amount,
    row: {
      advanceReceiveId: advance.id,
      storeId: ctx.storeId,
      amount: adj.amount,
      adjustedAmount: adj.amount,
      previousBalance: available,
      remainingBalance,
      cashierName: ctx.cashierName,
    },
    log: {
      customerId: ctx.customer.customerId,
      storeId: ctx.storeId,
      adjustmentType: "ADVANCE",
      referenceId: advance.id,
      referenceDocNo: `ADV-${advance.id}`,
      saleInvoiceNo: ctx.invoiceNo,
      totalOriginal: roundMoney(Number(advance.amount || 0)),
      previousBalance: available,
      adjustedAmount: adj.amount,
      remainingBalance,
      cashierName: ctx.cashierName,
      notes: adj.notes || `Advance adjusted in sale ${ctx.invoiceNo}`,
    },
  };
};

/** Consumes an old-gold purchase value with an atomic conditional update (BRIEF rule 1). */
const applyOldGold = async (tx, adj, ctx) => {
  const purchase = await tx.purchase.findFirst({
    where: { id: adj.id, storeId: ctx.storeId, purchaseType: "OLD" },
    include: { items: { include: { item: true, product: true } } },
  });
  if (!purchase) throw new AppError(`Old jewellery purchase #${adj.id} was not found in this store.`, 404);
  const ref = purchase.invoiceNo || `PUR-OLD-${purchase.id}`;
  if (!belongsToCustomer({ ownerCustomerId: purchase.customerId, ownerPhone: purchase.customerPhone }, ctx.customer)) {
    throw new AppError(`Old jewellery purchase ${ref} belongs to another customer and cannot be used on this bill.`);
  }

  const available = oldGoldAdjustable(purchase);
  if (adj.amount > available + 0.01) {
    throw new AppError(
      `Requested old jewellery adjustment (Rs. ${formatMoney(adj.amount)}) exceeds the unpaid value (Rs. ${formatMoney(available)}) of ${ref}.`
    );
  }

  const res = await tx.purchase.updateMany({
    where: { id: purchase.id, storeId: ctx.storeId, purchaseType: "OLD", balanceAmount: { gte: adj.amount - 0.01 } },
    data: {
      adjustedAmount: { increment: adj.amount },
      balanceAmount: { decrement: adj.amount },
      dueAmount: { decrement: adj.amount },
    },
  });
  if (res.count === 0) throw new AppError(`Old jewellery ${ref} was just used on another bill. Please refresh and try again.`, 409);

  const after = await tx.purchase.findUnique({ where: { id: purchase.id }, select: { balanceAmount: true, dueAmount: true } });
  const remainingBalance = roundMoney(Math.max(0, after.balanceAmount));
  await tx.purchase.update({
    where: { id: purchase.id },
    data: {
      balanceAmount: remainingBalance,
      dueAmount: roundMoney(Math.max(0, after.dueAmount)),
      adjustmentStatus: remainingBalance <= 0.01 ? "FULLY_ADJUSTED" : "PARTIALLY_ADJUSTED",
    },
  });

  const primaryItem = purchase.items?.[0];
  return {
    purchase,
    amount: adj.amount,
    row: {
      purchaseId: purchase.id,
      storeId: ctx.storeId,
      description: adj.description || primaryItem?.item?.name || primaryItem?.product?.name || "Old Jewellery Value Adjusted",
      grossWeight: Number(primaryItem?.grossWeight || 0),
      stoneWeight: Number(primaryItem?.stoneWeight || 0),
      netWeight: Number(primaryItem?.netWeight || 0),
      purity: primaryItem?.purity ? Number(primaryItem.purity) : null,
      rate: Number(primaryItem?.rate || 0),
      metalAmount: Number(primaryItem?.metalAmount || 0),
      deductionAmount: 0,
      value: adj.amount,
      adjustedAmount: adj.amount,
      previousBalance: available,
      remainingBalance,
      cashierName: ctx.cashierName,
    },
    log: {
      customerId: ctx.customer.customerId,
      storeId: ctx.storeId,
      adjustmentType: "OLD_JEWELLERY",
      referenceId: purchase.id,
      referenceDocNo: ref,
      saleInvoiceNo: ctx.invoiceNo,
      totalOriginal: oldGoldValuation(purchase),
      previousBalance: available,
      adjustedAmount: adj.amount,
      remainingBalance,
      cashierName: ctx.cashierName,
      notes: adj.notes || `Old Jewellery adjusted in sale ${ctx.invoiceNo}`,
    },
  };
};

export const createSaleService = async (data, storeId, user = null) => {
  const numericStoreId = requireStoreId(storeId);
  if (!data || typeof data !== "object") throw new AppError("Invalid sale data.");

  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw new AppError("Please add at least one jewellery item to create a sale.");
  }
  if (data.items.length > MAX_LINES) throw new AppError(`A sale can have at most ${MAX_LINES} items.`);

  // ---- 1. validate the payload (nothing is trusted, nothing is written yet)
  const lines = data.items.map(parseLine);
  const inventoryIds = lines.map((l) => l.inventoryId);
  if (new Set(inventoryIds).size !== inventoryIds.length) {
    throw new AppError("The same inventory item / barcode cannot be added more than once in the same sale.");
  }
  const advanceReqs = parseAdjustments(data.advanceAdjustments, { idKeys: ["advanceReceiveId", "id"], label: "Advance" });
  const oldGoldReqs = parseAdjustments(data.oldGoldAdjustments, { idKeys: ["purchaseId", "id"], label: "Old jewellery" });
  const offerDiscount = toMoney(data.offerDiscount, { field: "Offer discount", max: MAX_AMOUNT });
  const headerDiscount = toMoney(data.discount, { field: "Discount", max: MAX_AMOUNT });
  const lessUrd = toMoney(data.lessUrd, { field: "Less URD", max: MAX_AMOUNT });
  const payments = parsePayments(data.payments);
  const saleDate = parseSaleDate(data.saleDate);
  const partyId = optionalId(data.partyId, "party");

  let clientRoundOff = null;
  if (data.roundOff !== undefined && data.roundOff !== null && String(data.roundOff).trim() !== "") {
    clientRoundOff = roundMoney(toNumber(data.roundOff, { field: "Round off", min: null, max: null }));
    if (Math.abs(clientRoundOff) >= 1) throw new AppError("Round off must be less than Rs. 1 (between -0.99 and 0.99).");
  }

  const rawPhone = String(data.customerPhone ?? "").trim();
  let customerPhone = cleanPhone(rawPhone);
  if (rawPhone && customerPhone.length !== 10) throw new AppError("Customer mobile number must have 10 digits.");

  const store = await prisma.store.findUnique({
    where: { id: numericStoreId },
    select: { id: true, storeName: true, state: true, gstNo: true, cinNo: true },
  });
  if (!store) throw new AppError("Store not found.", 404);

  return prisma.$transaction(
    async (tx) => {
      // ---- 2. claim stock first (the double-sale guard), then the invoice number
      await claimInventory(tx, inventoryIds, numericStoreId);
      const invoiceNo = await generateSaleInvoiceNo(numericStoreId, saleDate, tx);

      const inventoryRows = await tx.inventory.findMany({
        where: { id: { in: inventoryIds }, storeId: numericStoreId },
        include: { item: true, product: true, purityMaster: true },
      });
      const byId = new Map(inventoryRows.map((r) => [r.id, r]));

      // ---- 3. customer / party
      let customerName = cleanString(data.customerName, 150) || "";
      let customerAddress = cleanString(data.customerAddress, 500) || "";
      const customerCity = cleanString(data.customerCity, 100) || "";
      const customerPan = (cleanString(data.customerPan, 20) || "").toUpperCase();
      let customerGst = (cleanString(data.customerGst, 20) || "").toUpperCase();
      const customerState = (cleanString(data.customerState, 60) || "").toUpperCase();

      if (partyId) {
        const party = await tx.partymaster.findFirst({ where: { id: partyId, storeId: numericStoreId } });
        if (!party) throw new AppError("The selected party is not linked to this store. Please choose a valid party.");
        customerName = customerName || party.name || "";
        if (!customerPhone && cleanPhone(party.phone).length === 10) customerPhone = cleanPhone(party.phone);
        customerAddress = customerAddress || party.address || "";
        customerGst = customerGst || (party.gst || "").toUpperCase();
      }

      if ((advanceReqs.length || oldGoldReqs.length) && !customerPhone) {
        throw new AppError("Enter the customer's mobile number to adjust an advance or old jewellery.");
      }

      const customer = await getOrCreateCustomerService(
        { customerName, customerPhone, customerAddress, customerCity, customerPan, customerGst, customerState },
        numericStoreId,
        tx
      );
      const customerId = customer?.id || null;

      // ---- 4. GST decided once, on the server, from the store master
      const storeState = String(store.state || "").trim().toUpperCase() || "ODISHA";
      const placeOfSupply = (cleanString(data.placeOfSupply, 60) || customerState || storeState).toUpperCase();
      const isInterState = placeOfSupply !== storeState;
      const gstType = isInterState ? "INTER" : "INTRA";
      const cashierName = cleanString(data.cashierName, 100) || user?.name || user?.email || store.storeName || "Cashier";

      // ---- 5. lines and totals
      const saleItems = lines.map((line, i) => buildSaleLine(line, byId.get(line.inventoryId), i));
      const grossAmount = roundMoney(saleItems.reduce((s, it) => s + it.totalAmount, 0));
      if (offerDiscount + headerDiscount > grossAmount + 0.01) {
        throw new AppError(`Discounts (${formatMoney(offerDiscount + headerDiscount)}) cannot exceed the item total (${formatMoney(grossAmount)}).`);
      }
      const taxableAmount = roundMoney(grossAmount - offerDiscount - headerDiscount);
      if (taxableAmount <= 0) throw new AppError("Discounts cannot reduce the invoice value to zero.");

      const cgstPercent = isInterState ? 0 : GST.CGST;
      const sgstPercent = isInterState ? 0 : GST.SGST;
      const igstPercent = isInterState ? GST.IGST : 0;
      const cgstAmount = roundMoney((taxableAmount * cgstPercent) / 100);
      const sgstAmount = roundMoney((taxableAmount * sgstPercent) / 100);
      const igstAmount = roundMoney((taxableAmount * igstPercent) / 100);
      const totalTax = roundMoney(cgstAmount + sgstAmount + igstAmount);
      const subTotal = roundMoney(taxableAmount + totalTax);
      allocateLineTax(saleItems, { grossAmount, taxableAmount, cgstAmount, sgstAmount, igstAmount });

      // ---- 6. advances and old gold (ownership + atomic balance updates; the tx rolls back on any error)
      const adjCtx = { storeId: numericStoreId, invoiceNo, cashierName, customer: { customerId, phone: customerPhone } };
      const usedAdvances = [];
      for (const adj of advanceReqs) usedAdvances.push(await applyAdvance(tx, adj, adjCtx));
      const usedOldGolds = [];
      for (const adj of oldGoldReqs) usedOldGolds.push(await applyOldGold(tx, adj, adjCtx));

      const totalAdvanceAdjusted = roundMoney(usedAdvances.reduce((s, a) => s + a.amount, 0));
      const totalOldGoldAdjusted = roundMoney(usedOldGolds.reduce((s, a) => s + a.amount, 0));
      const totalDeductions = roundMoney(totalAdvanceAdjusted + totalOldGoldAdjusted + lessUrd);
      if (totalDeductions > subTotal + 0.01) {
        throw new AppError(
          `Advance + old jewellery + Less URD (Rs. ${formatMoney(totalDeductions)}) cannot exceed the invoice value (Rs. ${formatMoney(subTotal)}). Reduce the adjusted amount.`
        );
      }

      // ---- 7. round-off (auto to the nearest rupee; a client value is only accepted when |x| < 1)
      const unroundedNet = roundMoney(subTotal - totalDeductions);
      let roundOff = clientRoundOff !== null ? clientRoundOff : roundMoney(Math.round(unroundedNet) - unroundedNet);
      if (unroundedNet + roundOff < 0) roundOff = roundMoney(-unroundedNet);
      const netPayable = roundMoney(unroundedNet + roundOff);

      // ---- 8. counter payments
      const paidAmount = roundMoney(payments.reduce((s, p) => s + p.amount, 0));
      if (paidAmount > netPayable + 0.01) {
        throw new AppError(`Payment amount (${formatMoney(paidAmount)}) cannot exceed net payable (${formatMoney(netPayable)}).`);
      }
      const dueAmount = roundMoney(Math.max(0, netPayable - paidAmount));

      // ---- 9. persist
      const sale = await createSaleRepo(
        {
          invoiceNo,
          storeId: numericStoreId,
          partyId,
          customerId,
          saleDate,
          status: "COMPLETED",

          customerName: customerName || null,
          customerPhone: customerPhone || null,
          customerAddress: customerAddress || null,
          customerCity: customerCity || null,
          customerPan: customerPan || null,
          customerGst: customerGst || null,
          customerState: customerState || null,
          placeOfSupply,

          cinNo: store.cinNo || null,
          storeGst: store.gstNo || null,
          cashierName,
          irnNo: cleanString(data.irnNo, 100),
          isCustomerCopy: data.isCustomerCopy !== undefined ? Boolean(data.isCustomerCopy) : true,

          grossAmount,
          offerDiscount,
          discount: headerDiscount,
          taxableAmount,

          cgstPercent,
          cgstAmount,
          sgstPercent,
          sgstAmount,
          igstPercent,
          igstAmount,
          totalTax,
          gstRate: GST.IGST,
          gstType,

          subTotal,
          lessUrd,
          roundOff,

          // Legacy fields for backward compatibility
          subtotal: grossAmount,
          igst: igstAmount,
          cgst: cgstAmount,
          sgst: sgstAmount,
          taxAmount: totalTax,
          grossTotal: netPayable,
          oldGoldAmount: totalOldGoldAdjusted,
          advanceAmount: totalAdvanceAdjusted,

          payableAmount: netPayable,
          netPayable,
          paidAmount,
          dueAmount,
          amountInWords: numberToWordsIndian(netPayable),

          termsAccepted: true,
          narration: cleanString(data.narration, 1000),

          items: { create: saleItems },
          payments: { create: payments.map((p) => ({ ...p, storeId: numericStoreId })) },
          advanceAdjustments: { create: usedAdvances.map((a) => a.row) },
          oldGolds: { create: usedOldGolds.map((o) => o.row) },
        },
        tx
      );

      if (customerId) {
        for (const used of [...usedAdvances, ...usedOldGolds]) {
          await createCustomerAdjustmentLogRepo({ ...used.log, saleId: sale.id }, tx);
        }
      }

      // ---- 10. ledger (same transaction: no sale without its journal)
      const journal = await postSaleJournal(tx, sale, { payments, advances: usedAdvances, oldGolds: usedOldGolds, lessUrd }, user);
      if (payments.length) {
        await tx.salePayment.updateMany({ where: { saleId: sale.id, voucherId: null }, data: { voucherId: journal.id } });
      }

      const fresh = await getSaleByIdRepo(sale.id, numericStoreId, tx);
      return withSaleItemUnits(fresh);
    },
    {
      maxWait: 60000,
      timeout: 300000,
    }
  );
};

/**
 * Cancels a sale in one transaction: stock back to AVAILABLE, advance / old-gold usage restored
 * (with reversal adjustment logs), and the SJ voucher reversed. Receipts must be cancelled first.
 */
export const cancelSaleService = async (id, storeId, { reason } = {}, user = null) => {
  const sid = requireStoreId(storeId);
  const saleId = parseId(id, "sale id");
  const why = cleanString(reason, 500);
  if (!why) throw new AppError("Please enter a reason for cancelling this invoice.");
  const cancelledBy = user?.name || user?.email || (user?.role ? `${user.role}#${user.id}` : "System");

  return prisma.$transaction(
    async (tx) => {
      const sale = await tx.sale.findFirst({
        where: { id: saleId, storeId: sid },
        include: { items: { select: { inventoryId: true } }, advanceAdjustments: true, oldGolds: true },
      });
      if (!sale) throw new AppError("Sale record not found.", 404);
      if (sale.status === "CANCELLED") throw new AppError(`Invoice ${sale.invoiceNo} is already cancelled.`);

      const receipt = await tx.voucher.findFirst({
        where: {
          storeId: sid,
          voucherType: "RECEIPT",
          status: "COMPLETED",
          OR: [{ saleId: sale.id }, { referenceType: "SALE_INVOICE", referenceId: sale.id }],
        },
        select: { voucherNo: true },
      });
      if (receipt) throw new AppError(`Cancel receipt ${receipt.voucherNo} first. Money received against this invoice must be reversed before the invoice is cancelled.`);

      const journal = await tx.voucher.findFirst({
        where: { storeId: sid, saleId: sale.id, referenceType: "SALE", status: "COMPLETED" },
        select: { id: true },
      });
      if (!journal) {
        throw new AppError(`Invoice ${sale.invoiceNo} was migrated from the old system (no ledger posting here) and cannot be cancelled in this app.`);
      }

      const flipped = await tx.sale.updateMany({
        where: { id: sale.id, storeId: sid, status: "COMPLETED" },
        data: { status: "CANCELLED", cancelledAt: new Date(), cancelledReason: why, cancelledBy },
      });
      if (flipped.count === 0) throw new AppError(`Invoice ${sale.invoiceNo} is already cancelled.`, 409);

      const inventoryIds = sale.items.map((it) => it.inventoryId);
      if (inventoryIds.length) {
        await tx.inventory.updateMany({
          where: { id: { in: inventoryIds }, storeId: sid, status: "SOLD" },
          data: { status: "AVAILABLE" },
        });
      }

      const reversalNote = `Reversed: sale ${sale.invoiceNo} cancelled (${why})`;
      const logs = [];

      for (const adj of sale.advanceAdjustments) {
        const amount = roundMoney(adj.amount || adj.adjustedAmount);
        if (amount <= 0) continue;
        const before = await tx.advanceReceive.findUnique({ where: { id: adj.advanceReceiveId } });
        if (!before) continue;
        const adjusted = roundMoney(Math.max(0, Number(before.adjustedAmount || 0) - amount));
        const balance = roundMoney(Math.min(Number(before.amount || 0), Number(before.balanceAmount || 0) + amount));
        await tx.advanceReceive.update({
          where: { id: before.id },
          data: {
            adjustedAmount: adjusted,
            balanceAmount: balance,
            ...(before.status === "CANCELLED" ? {} : { status: adjusted <= 0.01 ? "AVAILABLE" : "PARTIALLY_ADJUSTED" }),
          },
        });
        logs.push({
          adjustmentType: "ADVANCE",
          referenceId: before.id,
          referenceDocNo: `ADV-${before.id}`,
          totalOriginal: roundMoney(Number(before.amount || 0)),
          previousBalance: roundMoney(before.balanceAmount),
          adjustedAmount: -amount,
          remainingBalance: balance,
        });
      }

      for (const og of sale.oldGolds) {
        const amount = roundMoney(og.value || og.adjustedAmount);
        if (!og.purchaseId || amount <= 0) continue;
        const before = await tx.purchase.findUnique({ where: { id: og.purchaseId } });
        if (!before) continue;
        const adjusted = roundMoney(Math.max(0, Number(before.adjustedAmount || 0) - amount));
        const balance = roundMoney(Number(before.balanceAmount || 0) + amount);
        const due = roundMoney(Number(before.dueAmount || 0) + amount);
        const adjustmentStatus = adjusted > 0.01
          ? balance > 0.01 ? "PARTIALLY_ADJUSTED" : "FULLY_ADJUSTED"
          : balance > 0.01 ? "AVAILABLE" : "SETTLED";
        await tx.purchase.update({
          where: { id: before.id },
          data: { adjustedAmount: adjusted, balanceAmount: balance, dueAmount: due, adjustmentStatus },
        });
        logs.push({
          adjustmentType: "OLD_JEWELLERY",
          referenceId: before.id,
          referenceDocNo: before.invoiceNo || `PUR-OLD-${before.id}`,
          totalOriginal: oldGoldValuation(before),
          previousBalance: roundMoney(before.balanceAmount),
          adjustedAmount: -amount,
          remainingBalance: balance,
        });
      }

      if (sale.customerId) {
        for (const log of logs) {
          await createCustomerAdjustmentLogRepo(
            {
              ...log,
              customerId: sale.customerId,
              saleId: sale.id,
              storeId: sid,
              saleInvoiceNo: sale.invoiceNo,
              cashierName: cancelledBy,
              notes: reversalNote,
            },
            tx
          );
        }
      }

      await cancelVoucherAtomic(tx, { voucherId: journal.id, storeId: sid, reason: `Invoice ${sale.invoiceNo} cancelled: ${why}` });

      const fresh = await getSaleByIdRepo(sale.id, sid, tx);
      return withSaleItemUnits(fresh);
    },
    { maxWait: 60000, timeout: 120000 }
  );
};

export const getSalesService = async (storeId, options = {}) => {
  return getSalesRepo(requireStoreId(storeId), options);
};

export const getSaleByIdService = async (id, storeId) => {
  const sale = await getSaleByIdRepo(parseId(id, "sale id"), requireStoreId(storeId));

  if (!sale) {
    throw new AppError("Sale record not found. It may have been removed or you may not have access to it.", 404);
  }

  return withSaleItemUnits(sale);
};

export const getSaleCountService = async (storeId) => {
  return getSaleCountRepo(requireStoreId(storeId));
};

const REPORT_STATUSES = { COMPLETED: "COMPLETED", CANCELLED: "CANCELLED", ALL: null };

/** Invoice value = taxable + GST (before advance / old-gold / URD deductions). */
const invoiceValueOf = (sale) =>
  roundMoney(Number(sale.subTotal || 0) || Number(sale.taxableAmount || 0) + Number(sale.totalTax || sale.taxAmount || 0) || Number(sale.netPayable || 0));

export const getSalesReportService = async ({
  storeId,
  period = "THIS_MONTH",
  fromDate,
  toDate,
  status,
}) => {
  const sid = requireStoreId(storeId);
  const statusKey = String(status || "COMPLETED").trim().toUpperCase();
  if (!(statusKey in REPORT_STATUSES)) throw new AppError("Status must be COMPLETED, CANCELLED or ALL.");

  const dateRange = getReportDateRange(period, fromDate, toDate);

  const rows = await getSalesReportRepo(sid, dateRange.fromDate, dateRange.toDate, REPORT_STATUSES[statusKey]);
  const sales = rows.map((sale) => ({ ...sale, invoiceValue: invoiceValueOf(sale) }));

  const summary = sales.reduce(
    (acc, sale) => {
      acc.totalInvoices += 1;
      acc.totalItems += sale.items?.length || 0;

      const net = Number(sale.netPayable || sale.payableAmount || sale.grossTotal || 0);
      const invoiceValue = sale.invoiceValue;

      // Revenue is the invoice value; advance / old-gold settled sales are not ₹0 sales.
      acc.totalSales += invoiceValue;
      acc.totalInvoiceValue += invoiceValue;
      acc.invoiceValue += invoiceValue;
      acc.netSales += net;
      acc.totalAmount += net;
      acc.payableAmount += net;
      acc.netPayable += net;

      const gross = Number(sale.grossAmount || sale.subtotal || sale.subTotal || net);
      acc.totalGrossAmount += gross;
      acc.grossTotal += gross;
      acc.grossAmount += gross;

      acc.totalTaxable += Number(sale.taxableAmount || 0);

      const disc = Number(sale.discount || 0) + Number(sale.offerDiscount || 0);
      acc.totalDiscount += disc;

      const tax = Number(sale.totalTax || sale.taxAmount || 0);
      acc.totalTax += tax;
      acc.taxAmount += tax;

      const paid = Number(sale.paidAmount || 0);
      acc.totalPaid += paid;
      acc.paidAmount += paid;

      const due = Number(sale.dueAmount ?? Math.max(0, net - paid));
      acc.totalDue += due;
      acc.dueAmount += due;

      acc.totalAdvanceAdjusted += Number(sale.advanceAmount || 0);
      acc.totalOldGoldAdjusted += Number(sale.oldGoldAmount || 0);
      acc.totalLessUrd += Number(sale.lessUrd || 0);

      return acc;
    },
    {
      totalInvoices: 0,
      totalItems: 0,
      totalSales: 0,
      totalInvoiceValue: 0,
      invoiceValue: 0,
      netSales: 0,
      totalAmount: 0,
      payableAmount: 0,
      netPayable: 0,
      totalGrossAmount: 0,
      grossTotal: 0,
      grossAmount: 0,
      totalTaxable: 0,
      totalDiscount: 0,
      totalTax: 0,
      taxAmount: 0,
      totalPaid: 0,
      paidAmount: 0,
      totalDue: 0,
      dueAmount: 0,
      totalAdvanceAdjusted: 0,
      totalOldGoldAdjusted: 0,
      totalLessUrd: 0,
    }
  );
  for (const k of Object.keys(summary)) if (k !== "totalInvoices" && k !== "totalItems") summary[k] = roundMoney(summary[k]);

  return {
    filter: {
      period,
      status: statusKey,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
    },
    summary,
    sales,
  };
};

export { saleJournalNo };
