import prisma from "../../../config/db.js";
import { roundWeight } from "../../../utils/validate.js";
import { n, dateKey, sumBy } from "../engine.js";
import { INVENTORY_STATUS_FILTER, PURCHASE_TYPE_FILTER, PURCHASE_TYPE_LABEL, SEARCH_FILTER, contains, dateRangeWhere, pureOf, titleCase } from "./common.js";

const UNSPECIFIED = "Unspecified";

/** id → name lookups for the store's masters (one small query each). */
const masterNames = async (storeId) => {
  const [metals, purities, products, items] = await Promise.all([
    prisma.metal.findMany({ where: { storeId }, select: { id: true, name: true } }),
    prisma.purity.findMany({ where: { storeId }, select: { id: true, name: true, metalId: true } }),
    prisma.product.findMany({ where: { storeId }, select: { id: true, name: true } }),
    prisma.item.findMany({ where: { storeId }, select: { id: true, name: true } }),
  ]);
  const m = (list) => new Map(list.map((x) => [x.id, x.name]));
  return { metals: m(metals), purities: m(purities), purityMetal: new Map(purities.map((p) => [p.id, p.metalId])), products: m(products), items: m(items) };
};

const inventoryWhere = (storeId, filters) => {
  const where = { storeId };
  if (filters.status && filters.status !== "ALL") where.status = filters.status;
  if (filters.purchaseType && filters.purchaseType !== "ALL") where.purchaseType = filters.purchaseType;
  if (filters.search) {
    where.OR = [
      { barcodeNo: contains(filters.search) },
      { tagNo: contains(filters.search) },
      { huidNo: contains(filters.search) },
      { inventoryCode: contains(filters.search) },
      { item: { is: { name: contains(filters.search) } } },
      { product: { is: { name: contains(filters.search) } } },
    ];
  }
  return where;
};

const metalOrder = (name) => {
  const s = String(name || "").toLowerCase();
  if (s.includes("gold")) return 0;
  if (s.includes("silver")) return 1;
  if (s.includes("platinum")) return 2;
  if (s.includes("diamond")) return 3;
  return s === UNSPECIFIED.toLowerCase() ? 9 : 5;
};

// ---------------------------------------------------------------- stock summary
const WEIGHT_KEYS = ["pieces", "grossWeight", "stoneWeight", "netWeight", "pureWeight"];
const zero = () => ({ pieces: 0, grossWeight: 0, stoneWeight: 0, netWeight: 0, pureWeight: 0 });
const addInto = (acc, x) => {
  for (const k of WEIGHT_KEYS) acc[k] += n(x[k]);
  return acc;
};
const rounded = (x) => ({ ...x, pieces: Math.round(x.pieces), grossWeight: roundWeight(x.grossWeight), stoneWeight: roundWeight(x.stoneWeight), netWeight: roundWeight(x.netWeight), pureWeight: roundWeight(x.pureWeight) });

const stockSummary = {
  key: "stock-summary",
  name: "Stock Summary",
  group: "Stock",
  description: "Pieces and gross / net / pure weight on hand, grouped metal → purity → product (or item).",
  orientation: "portrait",
  period: "none",
  filters: [
    {
      name: "groupBy",
      label: "Group By",
      type: "select",
      default: "PRODUCT",
      options: [
        { value: "PRODUCT", label: "Metal → Purity → Product" },
        { value: "ITEM", label: "Metal → Purity → Item" },
        { value: "PURITY", label: "Metal → Purity" },
      ],
    },
    INVENTORY_STATUS_FILTER,
    PURCHASE_TYPE_FILTER,
  ],
  columns: (f) => [
    // grouped views print the metal as a section header, so the column is Excel/screen only there
    { key: "metal", label: "Metal", type: "text", repeat: false, ...(f.groupBy === "PURITY" ? {} : { pdf: false }) },
    { key: "purity", label: "Purity", type: "text", repeat: false },
    ...(f.groupBy === "PURITY" ? [] : [{ key: "name", label: f.groupBy === "ITEM" ? "Item" : "Product", type: "text" }]),
    { key: "pieces", label: "Pieces", type: "number", total: true, align: "center" },
    { key: "grossWeight", label: "Gross Wt (g)", type: "weight", total: true },
    { key: "stoneWeight", label: "Stone Wt (g)", type: "weight", total: true },
    { key: "netWeight", label: "Net Wt (g)", type: "weight", total: true },
    { key: "pureWeight", label: "Pure Wt (g)", type: "weight", total: true },
  ],
  query: async (storeId, _range, filters) => {
    const [pieces, names] = await Promise.all([
      prisma.inventory.findMany({
        where: inventoryWhere(storeId, filters),
        select: { metalId: true, purityId: true, productId: true, itemId: true, pieces: true, grossWeight: true, stoneWeight: true, netWeight: true, pureWeight: true, purity: true },
      }),
      masterNames(storeId),
    ]);
    // metal → purity → leaf
    const tree = new Map();
    for (const p of pieces) {
      const metal = names.metals.get(p.metalId ?? names.purityMetal.get(p.purityId)) || UNSPECIFIED;
      const purity = names.purities.get(p.purityId) || (p.purity ? `${p.purity}%` : UNSPECIFIED);
      const leaf = filters.groupBy === "ITEM" ? names.items.get(p.itemId) || UNSPECIFIED : filters.groupBy === "PRODUCT" ? names.products.get(p.productId) || UNSPECIFIED : "";
      const x = { pieces: p.pieces ?? 1, grossWeight: p.grossWeight, stoneWeight: p.stoneWeight, netWeight: p.netWeight, pureWeight: pureOf(p.pureWeight, p.netWeight, p.purity) };
      if (!tree.has(metal)) tree.set(metal, new Map());
      const pm = tree.get(metal);
      if (!pm.has(purity)) pm.set(purity, new Map());
      const lm = pm.get(purity);
      lm.set(leaf, addInto(lm.get(leaf) || zero(), x));
    }
    const rows = [];
    const byMetal = [];
    const metals = [...tree.keys()].sort((a, b) => metalOrder(a) - metalOrder(b) || a.localeCompare(b));
    for (const metal of metals) {
      const pm = tree.get(metal);
      const metalTotal = zero();
      if (filters.groupBy !== "PURITY") rows.push({ _kind: "group", metal: metal.toUpperCase(), _label: metal.toUpperCase() });
      const purities = [...pm.keys()].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const purity of purities) {
        const lm = pm.get(purity);
        const purityTotal = zero();
        const leaves = [...lm.entries()].sort((a, b) => b[1].netWeight - a[1].netWeight);
        for (const [leaf, x] of leaves) {
          addInto(purityTotal, x);
          if (filters.groupBy !== "PURITY") rows.push(rounded({ metal, purity, name: leaf, ...x }));
        }
        addInto(metalTotal, purityTotal);
        if (filters.groupBy === "PURITY") rows.push(rounded({ metal, purity, ...purityTotal }));
        else if (leaves.length > 1) rows.push(rounded({ _kind: "subtotal", _label: `${purity} total`, metal, purity, ...purityTotal }));
      }
      rows.push(rounded({ _kind: "subtotal", _label: `${metal} total`, _strong: true, metal, ...metalTotal }));
      byMetal.push({ metal, ...rounded(metalTotal) });
    }
    const all = byMetal.reduce((acc, m) => addInto(acc, m), zero());
    const summary = [
      { label: "Pieces", value: Math.round(all.pieces), type: "number" },
      ...byMetal.slice(0, 3).map((m) => ({ label: `${m.metal} Net Wt (g)`, value: m.netWeight, type: "weight" })),
      { label: "Total Net Wt (g)", value: roundWeight(all.netWeight), type: "weight" },
      { label: "Total Pure Wt (g)", value: roundWeight(all.pureWeight), type: "weight" },
    ];
    // Grand totals across metals (metal-wise addition is not meaningful in grams of different metals,
    // but jewellers still read the combined pieces/weight line).
    const totals = rounded(all);
    return { rows, totals, totalsLabel: "Grand Total", summary };
  },
};

// ---------------------------------------------------------------- stock register (piece-wise)
const stockRegister = {
  key: "stock-register",
  name: "Stock Register",
  group: "Stock",
  description: "Piece-wise list of tagged stock with barcode, tag, HUID, purity and weights.",
  orientation: "landscape",
  period: "none",
  filters: [INVENTORY_STATUS_FILTER, PURCHASE_TYPE_FILTER, SEARCH_FILTER("Barcode / tag / HUID / item")],
  columns: [
    { key: "tagNo", label: "Tag No", type: "text" },
    { key: "barcodeNo", label: "Barcode", type: "text" },
    { key: "inventoryCode", label: "Stock Code", type: "text", pdf: false },
    { key: "item", label: "Item", type: "text" },
    { key: "product", label: "Product", type: "text" },
    { key: "metal", label: "Metal", type: "text" },
    { key: "purity", label: "Purity", type: "text" },
    { key: "pieces", label: "Pcs", type: "number", total: true, align: "center" },
    { key: "grossWeight", label: "Gross Wt (g)", type: "weight", total: true },
    { key: "stoneWeight", label: "Stone Wt (g)", type: "weight", total: true },
    { key: "netWeight", label: "Net Wt (g)", type: "weight", total: true },
    { key: "pureWeight", label: "Pure Wt (g)", type: "weight", total: true },
    { key: "huidNo", label: "HUID", type: "text" },
    { key: "source", label: "Source", type: "text", pdf: false },
    { key: "inwardDate", label: "Inward", type: "date" },
    { key: "status", label: "Status", type: "text" },
  ],
  query: async (storeId, _range, filters) => {
    const [pieces, names] = await Promise.all([
      prisma.inventory.findMany({
        where: inventoryWhere(storeId, filters),
        select: {
          inventoryCode: true,
          tagNo: true,
          barcodeNo: true,
          huidNo: true,
          status: true,
          purchaseType: true,
          metalId: true,
          purityId: true,
          productId: true,
          itemId: true,
          pieces: true,
          grossWeight: true,
          stoneWeight: true,
          netWeight: true,
          pureWeight: true,
          purity: true,
          createdAt: true,
          purchase: { select: { date: true, invoiceNo: true } },
        },
        orderBy: [{ metalId: "asc" }, { purityId: "asc" }, { id: "asc" }],
      }),
      masterNames(storeId),
    ]);
    const rows = pieces.map((p) => ({
      tagNo: p.tagNo || "",
      barcodeNo: p.barcodeNo || "",
      inventoryCode: p.inventoryCode,
      item: names.items.get(p.itemId) || "",
      product: names.products.get(p.productId) || "",
      metal: names.metals.get(p.metalId ?? names.purityMetal.get(p.purityId)) || "",
      purity: names.purities.get(p.purityId) || (p.purity ? `${p.purity}%` : ""),
      pieces: p.pieces ?? 1,
      grossWeight: roundWeight(p.grossWeight),
      stoneWeight: roundWeight(p.stoneWeight),
      netWeight: roundWeight(p.netWeight),
      pureWeight: roundWeight(pureOf(p.pureWeight, p.netWeight, p.purity)),
      huidNo: p.huidNo || "",
      source: [PURCHASE_TYPE_LABEL[p.purchaseType], p.purchase?.invoiceNo].filter(Boolean).join(" · "),
      inwardDate: dateKey(p.purchase?.date || p.createdAt),
      status: titleCase(p.status),
    }));
    const summary = [
      { label: "Pieces", value: Math.round(sumBy(rows, "pieces")), type: "number" },
      { label: "Gross Wt (g)", value: roundWeight(sumBy(rows, "grossWeight")), type: "weight" },
      { label: "Net Wt (g)", value: roundWeight(sumBy(rows, "netWeight")), type: "weight" },
      { label: "Pure Wt (g)", value: roundWeight(sumBy(rows, "pureWeight")), type: "weight" },
      { label: "With HUID", value: rows.filter((r) => r.huidNo).length, type: "number" },
    ];
    return { rows, summary };
  },
};

// ---------------------------------------------------------------- pure metal register
const pureMetalRegister = {
  key: "pure-metal-register",
  name: "Pure Metal Register",
  group: "Stock",
  description: "Metal weight in vs out per metal and purity: purchased, old gold received, sold, and stock on hand.",
  orientation: "landscape",
  defaultPeriod: "THIS_MONTH",
  filters: [],
  columns: [
    { key: "metal", label: "Metal", type: "text", repeat: false },
    { key: "purity", label: "Purity", type: "text" },
    { key: "purchasedNet", label: "Purchased Net (g)", type: "weight", total: true },
    { key: "purchasedPure", label: "Purchased Pure (g)", type: "weight", total: true },
    { key: "oldNet", label: "Old Gold Net (g)", type: "weight", total: true },
    { key: "oldPure", label: "Old Gold Pure (g)", type: "weight", total: true },
    { key: "soldNet", label: "Sold Net (g)", type: "weight", total: true },
    { key: "soldPure", label: "Sold Pure (g)", type: "weight", total: true },
    { key: "netPure", label: "Net Pure In/Out (g)", type: "weight", total: true },
    { key: "stockPure", label: "In Stock Pure (g)", type: "weight", total: true },
  ],
  query: async (storeId, range, _filters) => {
    const d = dateRangeWhere(range);
    const [bought, sold, stock, names] = await Promise.all([
      prisma.purchaseItem.findMany({
        where: { purchase: { is: { storeId, isOpeningStock: false, ...(d ? { date: d } : {}) } } },
        select: { metalId: true, purityId: true, netWeight: true, pureWeight: true, purity: true, purchase: { select: { purchaseType: true } } },
      }),
      prisma.saleItem.findMany({
        where: { sale: { is: { storeId, status: "COMPLETED", ...(d ? { saleDate: d } : {}) } } },
        select: { netWeight: true, purity: true, inventory: { select: { metalId: true, purityId: true, purity: true, pureWeight: true, netWeight: true } } },
      }),
      prisma.inventory.findMany({ where: { storeId, status: "AVAILABLE" }, select: { metalId: true, purityId: true, netWeight: true, pureWeight: true, purity: true } }),
      masterNames(storeId),
    ]);
    const rowsMap = new Map();
    const bucket = (metalId, purityId, purity) => {
      const metal = names.metals.get(metalId ?? names.purityMetal.get(purityId)) || UNSPECIFIED;
      const pur = names.purities.get(purityId) || (purity ? `${purity}%` : UNSPECIFIED);
      const k = `${metal}|${pur}`;
      if (!rowsMap.has(k)) rowsMap.set(k, { metal, purity: pur, purchasedNet: 0, purchasedPure: 0, oldNet: 0, oldPure: 0, soldNet: 0, soldPure: 0, netPure: 0, stockPure: 0 });
      return rowsMap.get(k);
    };
    for (const b of bought) {
      const r = bucket(b.metalId, b.purityId, b.purity);
      const pure = pureOf(b.pureWeight, b.netWeight, b.purity);
      if (b.purchase?.purchaseType === "OLD") {
        r.oldNet += n(b.netWeight);
        r.oldPure += pure;
      } else {
        r.purchasedNet += n(b.netWeight);
        r.purchasedPure += pure;
      }
    }
    for (const s of sold) {
      const inv = s.inventory || {};
      const r = bucket(inv.metalId, inv.purityId, inv.purity ?? s.purity);
      const net = n(s.netWeight) || n(inv.netWeight);
      const pure = n(inv.pureWeight) > 0 && n(inv.netWeight) > 0 ? (n(inv.pureWeight) * net) / n(inv.netWeight) : pureOf(0, net, s.purity ?? inv.purity);
      r.soldNet += net;
      r.soldPure += pure;
    }
    for (const s of stock) bucket(s.metalId, s.purityId, s.purity).stockPure += pureOf(s.pureWeight, s.netWeight, s.purity);
    const rows = [...rowsMap.values()]
      .map((r) => {
        const out = { ...r, netPure: r.purchasedPure + r.oldPure - r.soldPure };
        for (const k of Object.keys(out)) if (typeof out[k] === "number") out[k] = roundWeight(out[k]);
        return out;
      })
      .sort((a, b) => metalOrder(a.metal) - metalOrder(b.metal) || a.metal.localeCompare(b.metal) || b.purity.localeCompare(a.purity, undefined, { numeric: true }));
    const gold = rows.filter((r) => /gold/i.test(r.metal));
    const silver = rows.filter((r) => /silver/i.test(r.metal));
    const summary = [
      { label: "Gold Purchased Pure (g)", value: roundWeight(sumBy(gold, "purchasedPure") + sumBy(gold, "oldPure")), type: "weight" },
      { label: "Gold Sold Pure (g)", value: roundWeight(sumBy(gold, "soldPure")), type: "weight" },
      { label: "Gold In Stock Pure (g)", value: roundWeight(sumBy(gold, "stockPure")), type: "weight" },
      { label: "Silver Purchased Pure (g)", value: roundWeight(sumBy(silver, "purchasedPure") + sumBy(silver, "oldPure")), type: "weight" },
      { label: "Silver Sold Pure (g)", value: roundWeight(sumBy(silver, "soldPure")), type: "weight" },
      { label: "Silver In Stock Pure (g)", value: roundWeight(sumBy(silver, "stockPure")), type: "weight" },
    ];
    return {
      rows,
      summary,
      notes: ["Pure weight = recorded pure weight, otherwise net weight × purity %. In-stock pure is the current AVAILABLE stock (not limited to the period)."],
    };
  },
};

export default [stockSummary, stockRegister, pureMetalRegister];
