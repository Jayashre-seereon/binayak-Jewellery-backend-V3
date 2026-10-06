import prisma from "../config/db.js";
import { AppError, roundMoney, roundWeight } from "../utils/validate.js";

// All day/week/month boundaries and chart buckets are shop time: the process runs in
// Asia/Kolkata (config/timezone.js), so local Date getters are IST.
const PERIODS = ["today", "this_week", "this_month"];

const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** [start, end) of the selected period. */
const getDateRange = (period, now = new Date()) => {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === "today") return { start: today, end: addDays(today, 1) };
  if (period === "this_week") {
    const start = addDays(today, -((today.getDay() + 6) % 7)); // Monday
    return { start, end: addDays(start, 7) };
  }
  return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
};

export const normalizePeriod = (period) => {
  if (period === undefined || period === null || String(period).trim() === "") return "this_month";
  const p = String(period).trim().toLowerCase();
  if (!PERIODS.includes(p)) throw new AppError(`Invalid period "${period}". Use today, this_week or this_month.`);
  return p;
};

/** Gold karat bucket from purity/grade names ("22 Carat", "916", "24CT (99.99%)") or grade percentage. */
const goldKarat = (purityName, gradeName, gradePct) => {
  const s = `${purityName || ""} ${gradeName || ""}`;
  if (/\b24\s*(k|kt|ct|carat|karat)\b|\b(999|995)\b|99\.9|99\.5/i.test(s)) return "24";
  if (/\b22\s*(k|kt|ct|carat|karat)\b|\b916\b|91\.6/i.test(s)) return "22";
  if (/\b18\s*(k|kt|ct|carat|karat)\b|\b750\b|75\.0/i.test(s)) return "18";
  const pct = Number(gradePct);
  if (pct >= 99) return "24";
  if (pct >= 91 && pct <= 92.5) return "22";
  if (pct >= 74.5 && pct <= 76) return "18";
  return null;
};

const buildLiveRates = (rates) => {
  const live = { gold24k: null, gold22k: null, gold18k: null, silver: null };
  const at = {};
  const put = (key, r) => {
    const t = new Date(r.effectiveDate).getTime();
    if (live[key] === null || t > at[key]) {
      live[key] = roundMoney(r.saleRate);
      at[key] = t;
    }
  };
  for (const r of rates) {
    if (/gold/i.test(r.metalName)) {
      const k = goldKarat(r.purityName, r.gradeName, r.gradePercentage);
      if (k) put(`gold${k}k`, r);
    } else if (/silver/i.test(r.metalName)) {
      put("silver", r);
    }
  }
  return live;
};

const SLOTS = [
  { label: "8 AM - 10 AM", from: 8, to: 10 },
  { label: "10 AM - 12 PM", from: 10, to: 12 },
  { label: "12 PM - 2 PM", from: 12, to: 14 },
  { label: "2 PM - 4 PM", from: 14, to: 16 },
  { label: "4 PM - 6 PM", from: 16, to: 18 },
  { label: "6 PM - 8 PM", from: 18, to: 20 },
  { label: "8 PM - 10 PM", from: 20, to: 22 },
];

const buildTrend = (period, start, end, salesList) => {
  if (period === "today") {
    const slots = SLOTS.map((s) => ({ name: s.label, sales: 0, bills: 0 }));
    for (const s of salesList) {
      const h = new Date(s.saleDate).getHours();
      // Before opening counts in the first slot, after closing in the last.
      const idx = h < 8 ? 0 : h >= 22 ? SLOTS.length - 1 : SLOTS.findIndex((sl) => h >= sl.from && h < sl.to);
      slots[idx].sales = roundMoney(slots[idx].sales + Number(s.subTotal || 0));
      slots[idx].bills += 1;
    }
    return slots;
  }

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const map = new Map();
  for (let d = new Date(start); d < end; d = addDays(d, 1)) {
    const month = d.toLocaleDateString("en-IN", { month: "short" });
    map.set(dayKey(d), period === "this_week"
      ? { name: `${dayNames[d.getDay()]} (${d.getDate()} ${month})`, shortName: dayNames[d.getDay()], sales: 0, bills: 0 }
      : { name: `${d.getDate()} ${month}`, shortName: `${d.getDate()}`, sales: 0, bills: 0 });
  }
  for (const s of salesList) {
    const row = map.get(dayKey(new Date(s.saleDate)));
    if (row) {
      row.sales = roundMoney(row.sales + Number(s.subTotal || 0));
      row.bills += 1;
    }
  }
  return Array.from(map.values());
};

export const getDashboardSummaryService = async (storeId, period) => {
  const sid = Number(storeId);
  if (!Number.isInteger(sid) || sid <= 0) throw new AppError("Please select a store.");
  const normalizedPeriod = normalizePeriod(period);
  const { start, end } = getDateRange(normalizedPeriod);
  const inPeriod = { gte: start, lt: end };

  const [rateRows, salesAgg, soldByMetalRows, salesList, stockGroups, advances, supplierDues, recentSales] = await Promise.all([
    // Latest rate per metal/purity/grade (ordered so the first row of each combination is the newest).
    prisma.rateMaster.findMany({
      // A non-positive rate is invalid input, never a board rate.
      where: { storeId: sid, saleRate: { gt: 0 } },
      distinct: ["metalId", "purityId", "gradeId"],
      orderBy: [{ metalId: "asc" }, { purityId: "asc" }, { gradeId: "asc" }, { effectiveDate: "desc" }, { id: "desc" }],
      select: {
        metalId: true,
        purityId: true,
        gradeId: true,
        unit: true,
        saleRate: true,
        exchangeRate: true,
        cashRate: true,
        effectiveDate: true,
        metal: { select: { name: true } },
        purity: { select: { name: true } },
        grade: { select: { name: true, percentage: true } },
      },
    }),
    prisma.sale.aggregate({
      _sum: { subTotal: true, grossAmount: true, discount: true, totalTax: true, netPayable: true, paidAmount: true, dueAmount: true },
      _count: { id: true },
      where: { storeId: sid, status: "COMPLETED", saleDate: inPeriod },
    }),
    prisma.$queryRaw`
      SELECT i."metalId" AS "metalId",
             COALESCE(SUM(si.pieces), 0)::float8 AS pieces,
             COALESCE(SUM(si."grossWeight"), 0)::float8 AS "grossWeight",
             COALESCE(SUM(si."netWeight"), 0)::float8 AS "netWeight"
        FROM "SaleItem" si
        JOIN "Sale" s ON s.id = si."saleId"
        JOIN "Inventory" i ON i.id = si."inventoryId"
       WHERE s."storeId" = ${sid} AND s.status = 'COMPLETED' AND s."saleDate" >= ${start} AND s."saleDate" < ${end}
       GROUP BY i."metalId"`,
    prisma.sale.findMany({
      where: { storeId: sid, status: "COMPLETED", saleDate: inPeriod },
      select: { saleDate: true, subTotal: true },
    }),
    prisma.inventory.groupBy({
      by: ["metalId"],
      where: { storeId: sid, status: "AVAILABLE" },
      _sum: { pieces: true, grossWeight: true, netWeight: true },
      _count: { _all: true },
    }),
    prisma.advanceReceive.aggregate({
      _sum: { balanceAmount: true },
      _count: { id: true },
      where: { storeId: sid, status: { in: ["AVAILABLE", "PARTIALLY_ADJUSTED"] }, balanceAmount: { gt: 0.01 } },
    }),
    prisma.purchase.aggregate({
      _sum: { dueAmount: true },
      _count: { id: true },
      where: { storeId: sid, dueAmount: { gt: 0.01 } },
    }),
    prisma.sale.findMany({
      where: { storeId: sid, status: "COMPLETED" },
      select: {
        id: true,
        invoiceNo: true,
        customerName: true,
        customerPhone: true,
        saleDate: true,
        subTotal: true,
        netPayable: true,
        paidAmount: true,
        dueAmount: true,
        status: true,
      },
      orderBy: [{ saleDate: "desc" }, { id: "desc" }],
      take: 6,
    }),
  ]);

  const metalIds = [...new Set([...stockGroups.map((g) => g.metalId), ...soldByMetalRows.map((r) => r.metalId)].filter(Boolean))];
  const metals = metalIds.length
    ? await prisma.metal.findMany({ where: { id: { in: metalIds } }, select: { id: true, name: true } })
    : [];
  const metalName = (id) => metals.find((m) => m.id === id)?.name || "Unspecified";

  const rates = rateRows.map((r) => ({
    metalId: r.metalId,
    purityId: r.purityId,
    gradeId: r.gradeId,
    metalName: r.metal?.name || null,
    purityName: r.purity?.name || null,
    gradeName: r.grade?.name || null,
    gradePercentage: r.grade?.percentage ?? null,
    unit: r.unit,
    saleRate: roundMoney(r.saleRate),
    exchangeRate: roundMoney(r.exchangeRate),
    cashRate: roundMoney(r.cashRate),
    effectiveDate: r.effectiveDate,
  }));

  const stockByMetal = stockGroups
    .map((g) => ({
      metalId: g.metalId,
      metalName: metalName(g.metalId),
      pieces: Number(g._sum.pieces || 0),
      tags: g._count._all,
      grossWeight: roundWeight(g._sum.grossWeight || 0),
      netWeight: roundWeight(g._sum.netWeight || 0),
    }))
    .sort((a, b) => b.netWeight - a.netWeight);

  const soldByMetal = soldByMetalRows
    .map((r) => ({
      metalId: r.metalId,
      metalName: metalName(r.metalId),
      pieces: Number(r.pieces || 0),
      grossWeight: roundWeight(r.grossWeight),
      netWeight: roundWeight(r.netWeight),
    }))
    .sort((a, b) => b.netWeight - a.netWeight);

  const s = salesAgg._sum;
  const sales = {
    // Revenue = invoice value (subTotal); advance / old-gold settled value is still a sale.
    totalRevenue: roundMoney(s.subTotal || 0),
    invoiceValue: roundMoney(s.subTotal || 0),
    grossAmount: roundMoney(s.grossAmount || 0),
    discount: roundMoney(s.discount || 0),
    totalTax: roundMoney(s.totalTax || 0),
    netReceivable: roundMoney(s.netPayable || 0),
    collected: roundMoney(s.paidAmount || 0),
    due: roundMoney(s.dueAmount || 0),
    invoicesCount: salesAgg._count.id || 0,
    grossWeightSold: roundWeight(soldByMetal.reduce((a, r) => a + r.grossWeight, 0)),
    netWeightSold: roundWeight(soldByMetal.reduce((a, r) => a + r.netWeight, 0)),
    piecesSold: soldByMetal.reduce((a, r) => a + r.pieces, 0),
    soldByMetal,
  };

  const inventory = {
    totalPieces: stockByMetal.reduce((a, r) => a + r.pieces, 0),
    totalTags: stockByMetal.reduce((a, r) => a + r.tags, 0),
    totalGrossWeight: roundWeight(stockByMetal.reduce((a, r) => a + r.grossWeight, 0)),
    totalNetWeight: roundWeight(stockByMetal.reduce((a, r) => a + r.netWeight, 0)),
    stockByMetal,
  };

  return {
    storeId: sid,
    period: normalizedPeriod,
    dateRange: { startDate: start.toISOString(), endDate: new Date(end.getTime() - 1).toISOString() },
    rates,
    liveRates: buildLiveRates(rates),
    sales,
    inventory,
    stockByMetal,
    customerAdvances: {
      totalAvailableBalance: roundMoney(advances._sum.balanceAmount || 0),
      activeAdvancesCount: advances._count.id || 0,
    },
    supplierDues: {
      totalSupplierDue: roundMoney(supplierDues._sum.dueAmount || 0),
      pendingPurchasesCount: supplierDues._count.id || 0,
    },
    salesTrend: buildTrend(normalizedPeriod, start, end, salesList),
    recentSales,
  };
};
