import prisma from "../config/db.js";
import {
  findCustomerByPhoneRepo,
  findCustomerByIdRepo,
  createCustomerRepo,
  updateCustomerRepo,
  getCustomerAdjustmentLogsRepo,
  listCustomersRepo,
} from "../repositories/customerRepository.js";
import { AppError, cleanPhone, roundMoney, parseId } from "../utils/validate.js";
import { nextCounter } from "../utils/counter.js";
import { advanceAvailable, oldGoldAdjustable, oldGoldValuation, last10 } from "./sales/balances.js";

const requireStoreId = (storeId) => {
  const sid = Number(Array.isArray(storeId) ? storeId[0] : storeId);
  if (!Number.isInteger(sid) || sid <= 0) throw new AppError("Please select a store.");
  return sid;
};

/**
 * Finds the store's customer for a phone, creating it when missing.
 * Signature kept for purchase/accounting callers: (data, storeId, tx).
 * Customer codes come from the per-store counter: C{storeId}-{seq6} (globally unique).
 */
export const getOrCreateCustomerService = async (data, storeId, tx = prisma) => {
  const sid = requireStoreId(storeId);
  const phone = cleanPhone(data.customerPhone || data.phone);
  if (!phone) return null;

  let customer = await findCustomerByPhoneRepo(phone, sid, tx);

  if (!customer) {
    const seq = await nextCounter(sid, "lastCustomerNumber", tx);
    customer = await createCustomerRepo(
      {
        name: data.customerName || data.name || "Customer",
        phone,
        address: data.customerAddress || data.address || null,
        city: data.customerCity || data.city || null,
        state: data.customerState || data.state || "ODISHA",
        pan: data.customerPan || data.pan || null,
        gst: data.customerGst || data.gst || null,
        idType: data.customerIdType || data.idType || null,
        idNumber: data.customerIdNumber || data.idNumber || null,
        customerCode: `C${sid}-${String(seq).padStart(6, "0")}`,
        storeId: sid,
      },
      tx
    );
  } else {
    // Fill in blanks only; never overwrite details the store already holds.
    const updateData = {};
    const name = String(data.customerName || "").trim();
    if (name && customer.name === "Customer") updateData.name = name;
    if (data.customerAddress && !customer.address) updateData.address = String(data.customerAddress);
    if (data.customerCity && !customer.city) updateData.city = String(data.customerCity);
    if (data.customerPan && !customer.pan) updateData.pan = String(data.customerPan);
    if (data.customerGst && !customer.gst) updateData.gst = String(data.customerGst);

    if (Object.keys(updateData).length > 0) {
      customer = await updateCustomerRepo(customer.id, updateData, tx);
    }
  }

  return customer;
};

const emptyLookup = () => ({
  exists: false,
  customer: null,
  availableAdvances: [],
  availableOldJewellery: [],
  allAdvances: [],
  allOldJewellery: [],
  adjustmentLogs: [],
  pastSales: [],
  summary: {
    totalAvailableAdvance: 0,
    totalAvailableOldGold: 0,
    totalAdjustedHistory: 0,
    totalSalesCount: 0,
  },
});

/** Read-only customer 360 for one store: advances, old gold, adjustment history, past sales. */
export const lookupCustomerByPhoneService = async (phone, storeId) => {
  const sid = requireStoreId(storeId);
  const p = last10(phone);
  if (p.length < 10) return emptyLookup();

  const customer = await findCustomerByPhoneRepo(p, sid);
  const ownerFilter = (phoneField) => [
    ...(customer?.id ? [{ customerId: customer.id }] : []),
    { [phoneField]: { endsWith: p } },
  ];

  const [advances, oldPurchases, adjustmentLogs, pastSales] = await Promise.all([
    prisma.advanceReceive.findMany({
      where: { storeId: sid, status: { not: "CANCELLED" }, OR: ownerFilter("contactNumber") },
      include: {
        vouchers: { select: { voucherNo: true, date: true, status: true } },
        saleAdjustments: {
          include: { sale: { select: { id: true, invoiceNo: true, saleDate: true, status: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.purchase.findMany({
      where: { storeId: sid, purchaseType: "OLD", OR: ownerFilter("customerPhone") },
      include: {
        items: { include: { item: true, product: true, metal: true, purityMaster: true } },
        saleOldGolds: {
          include: { sale: { select: { id: true, invoiceNo: true, saleDate: true, status: true } } },
        },
      },
      orderBy: { date: "desc" },
    }),
    customer?.id ? getCustomerAdjustmentLogsRepo(customer.id, sid) : Promise.resolve([]),
    prisma.sale.findMany({
      where: { storeId: sid, OR: ownerFilter("customerPhone") },
      select: {
        id: true,
        invoiceNo: true,
        saleDate: true,
        status: true,
        grossAmount: true,
        totalTax: true,
        subTotal: true,
        advanceAmount: true,
        oldGoldAmount: true,
        netPayable: true,
        paidAmount: true,
        dueAmount: true,
        cashierName: true,
      },
      orderBy: { saleDate: "desc" },
    }),
  ]);

  const allAdvances = advances.map((adv) => {
    const totalAmount = roundMoney(Number(adv.amount || 0));
    const balanceAmount = advanceAvailable(adv);
    const adjustedAmount = roundMoney(Math.max(0, totalAmount - balanceAmount));
    const isAvailable = balanceAmount > 0.01;

    const voucherNo = adv.vouchers?.find((v) => v.status !== "CANCELLED")?.voucherNo || adv.vouchers?.[0]?.voucherNo;
    const displayReceiptNo = voucherNo
      ? `${voucherNo}`
      : adv.specification && adv.specification.startsWith("Receipt Voucher")
      ? adv.specification.replace("Receipt Voucher ", "")
      : `ADV-${adv.id}`;

    return {
      id: adv.id,
      receiptNo: displayReceiptNo,
      voucherNo: voucherNo || null,
      date: adv.receiveDate || adv.createdAt,
      totalAmount,
      adjustedAmount,
      balanceAmount,
      paymentMode: adv.paymentMode,
      specification: adv.specification || "-",
      status: isAvailable ? (adjustedAmount > 0.01 ? "PARTIALLY_ADJUSTED" : "AVAILABLE") : "FULLY_ADJUSTED",
      isAvailable,
      adjustments: adv.saleAdjustments.map((adj) => ({
        id: adj.id,
        saleId: adj.saleId,
        invoiceNo: adj.sale?.invoiceNo || `#${adj.saleId}`,
        saleDate: adj.sale?.saleDate || adj.createdAt,
        saleStatus: adj.sale?.status || null,
        amount: Number(adj.amount || adj.adjustedAmount || 0),
        remainingBalance: Number(adj.remainingBalance || 0),
        cashierName: adj.cashierName || "-",
      })),
    };
  });

  const allOldJewellery = oldPurchases.map((pur) => {
    const totalValuation = oldGoldValuation(pur);
    const balanceAmount = oldGoldAdjustable(pur);
    const adjustedAmount = roundMoney(Number(pur.adjustedAmount || 0));
    const isAvailable = balanceAmount > 0.01;

    const itemSummary = pur.items
      .map((it) => {
        const name = it.item?.name || it.product?.name || it.metal?.name || "Old Jewellery";
        const purity = it.purityMaster?.name || (it.purity ? `${it.purity}K` : "");
        const wt = Number(it.grossWeight || 0).toFixed(3);
        return `${name} ${purity} (${wt}g)`;
      })
      .join(", ");

    const totalGrossWt = pur.items.reduce((s, it) => s + Number(it.grossWeight || 0), 0);
    const totalNetWt = pur.items.reduce((s, it) => s + Number(it.netWeight || it.grossWeight || 0), 0);
    const totalPcs = pur.items.reduce((s, it) => s + Number(it.pieces || 1), 0);

    return {
      id: pur.id,
      invoiceNo: pur.invoiceNo || pur.referenceNo || `PUR-OLD-${pur.id}`,
      date: pur.date,
      itemSummary: itemSummary || "Old Jewellery Items",
      totalPcs,
      totalGrossWeight: roundMoney(totalGrossWt),
      totalNetWeight: roundMoney(totalNetWt),
      totalValuation,
      paidAmount: roundMoney(Number(pur.paidAmount || 0)),
      adjustedAmount,
      balanceAmount,
      status: isAvailable ? (adjustedAmount > 0.01 ? "PARTIALLY_ADJUSTED" : "AVAILABLE") : adjustedAmount > 0.01 ? "FULLY_ADJUSTED" : "SETTLED",
      isAvailable,
      adjustments: pur.saleOldGolds.map((og) => ({
        id: og.id,
        saleId: og.saleId,
        invoiceNo: og.sale?.invoiceNo || `#${og.saleId}`,
        saleDate: og.sale?.saleDate || og.createdAt,
        saleStatus: og.sale?.status || null,
        amount: Number(og.value || og.adjustedAmount || 0),
        remainingBalance: Number(og.remainingBalance || 0),
        cashierName: og.cashierName || "-",
      })),
    };
  });

  const availableAdvances = allAdvances.filter((a) => a.isAvailable);
  const availableOldJewellery = allOldJewellery.filter((oj) => oj.isAvailable);

  return {
    exists: Boolean(customer),
    customer: customer || {
      name: "",
      phone: p,
      address: "",
      city: "",
      state: "ODISHA",
      pan: "",
      gst: "",
    },
    availableAdvances,
    availableOldJewellery,
    allAdvances,
    allOldJewellery,
    adjustmentLogs,
    pastSales,
    summary: {
      totalAvailableAdvance: roundMoney(availableAdvances.reduce((s, a) => s + a.balanceAmount, 0)),
      totalAvailableOldGold: roundMoney(availableOldJewellery.reduce((s, oj) => s + oj.balanceAmount, 0)),
      // reversal rows of cancelled sales carry negative amounts and net out here
      totalAdjustedHistory: roundMoney(adjustmentLogs.reduce((s, log) => s + Number(log.adjustedAmount || 0), 0)),
      totalSalesCount: pastSales.filter((s) => s.status !== "CANCELLED").length,
    },
  };
};

export const getCustomerHistoryService = async (id, storeId) => {
  const sid = requireStoreId(storeId);
  const customer = await findCustomerByIdRepo(parseId(id, "customer id"), sid);
  if (!customer) throw new AppError("Customer not found.", 404);
  return lookupCustomerByPhoneService(customer.phone, sid);
};

export const listCustomersService = async (storeId, { page = 1, limit = 100, search = "" } = {}) => {
  const sid = requireStoreId(storeId);
  const p = Math.max(1, Number.parseInt(page, 10) || 1);
  const l = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 100));
  const { customers, total } = await listCustomersRepo(sid, {
    search: String(search || "").trim().slice(0, 100),
    skip: (p - 1) * l,
    take: l,
  });
  return {
    customers,
    pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l), hasNextPage: p * l < total, hasPreviousPage: p > 1 },
  };
};
