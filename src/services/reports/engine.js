// Report engine: a registry of report definitions and one runner shared by the JSON,
// PDF and Excel outputs, so all three always show the same rows and totals.
//
// A definition:
//   { key, name, group, description, orientation: "portrait"|"landscape",
//     period: "range" | "none",        // "none" = position as on today (stock, trial balance)
//     defaultPeriod, filters: [{ name, label, type: "select"|"text"|"boolean", options, default }],
//     columns: [...] | (filters) => [...],
//     query: async (storeId, range, filters) => ({ rows, totals?, summary?, notes? }) }
// A column: { key, label, type: "text|date|money|weight|number|percent", align?, total?, pdf?, excel?, repeat? }
// Rows are plain objects keyed by column key. Optional row._kind = "group" | "subtotal" marks
// section headers / subtotal lines (styled by the renderers, excluded from automatic totals).
import prisma from "../../config/db.js";
import { AppError, roundMoney, roundWeight } from "../../utils/validate.js";
import { getReportDateRange, normalisePeriod, periodName, REPORT_PERIODS } from "../../utils/reportDateFilter.js";
import { formatDate, istDateKey } from "./theme.js";

const registry = new Map();

export const registerReports = (defs) => {
  for (const def of defs) {
    if (registry.has(def.key)) throw new Error(`Duplicate report key ${def.key}`);
    registry.set(def.key, def);
  }
};

export const getDefinition = (key) => registry.get(String(key || ""));

export const GROUP_ORDER = ["Sales", "Purchase", "Stock", "Accounts", "GST"];

/** Public catalogue (what the Reports hub renders). */
export const listReports = () =>
  [...registry.values()]
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
    .map((d) => ({
      key: d.key,
      name: d.name,
      group: d.group,
      description: d.description,
      period: d.period || "range",
      defaultPeriod: d.period === "none" ? null : d.defaultPeriod || "THIS_MONTH",
      periods: d.period === "none" ? [] : REPORT_PERIODS,
      filters: (d.filters || []).map(({ name, label, type, options, default: def }) => ({
        name,
        label,
        type,
        ...(options ? { options } : {}),
        ...(def !== undefined ? { default: def } : {}),
      })),
    }));

// ---------------------------------------------------------------- filters
const truthy = (v) => ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());

const parseFilters = (def, query) => {
  const out = {};
  const applied = [];
  for (const f of def.filters || []) {
    const raw = query[f.name];
    if (f.type === "boolean") {
      out[f.name] = raw === undefined || raw === "" ? Boolean(f.default) : truthy(raw);
      if (out[f.name] !== Boolean(f.default)) applied.push({ label: f.label, value: out[f.name] ? "Yes" : "No" });
    } else if (f.type === "select") {
      const value = raw === undefined || raw === "" ? f.default : String(raw).toUpperCase();
      const opt = (f.options || []).find((o) => String(o.value).toUpperCase() === String(value).toUpperCase());
      if (!opt) throw new AppError(`Invalid value "${raw}" for ${f.label}.`);
      out[f.name] = opt.value;
      applied.push({ label: f.label, value: opt.label });
    } else {
      const s = raw === undefined || raw === null ? "" : String(raw).trim().slice(0, 100);
      out[f.name] = s;
      if (s) applied.push({ label: f.label, value: s });
    }
  }
  return { filters: out, applied };
};

// ---------------------------------------------------------------- helpers for definitions
export const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Sums the `total` columns over normal rows (group/subtotal rows are skipped). */
export const computeTotals = (columns, rows) => {
  const totals = {};
  for (const c of columns) {
    if (!c.total) continue;
    let s = 0;
    for (const r of rows) if (!r._kind) s += n(r[c.key]);
    totals[c.key] = c.type === "weight" ? roundWeight(s) : c.type === "money" ? roundMoney(s) : Math.round(s * 100) / 100;
  }
  return totals;
};

export const sumBy = (rows, key) => rows.reduce((s, r) => s + n(r[key]), 0);

/** Last 10 digits of a phone, or "". */
export const phone10 = (v) => {
  const d = String(v || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d.length > 3 ? d : "";
};

export const dateKey = istDateKey;

// ---------------------------------------------------------------- runner
const loadStore = async (storeId) => {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { id: true, storeName: true, location: true, address: true, city: true, state: true, gstNo: true, phone: true, email: true, cinNo: true, tagline: true },
  });
  if (!store) throw new AppError("Store not found.", 404);
  return store;
};

export const resolveColumns = (def, filters) => (typeof def.columns === "function" ? def.columns(filters) : def.columns);

/**
 * Runs a report for a store. `query` is the raw request query (period, fromDate, toDate, filters).
 * Returns the CONTRACT §6 JSON shape (plus orientation for the renderers).
 */
export const runReport = async (key, storeId, query = {}) => {
  const def = getDefinition(key);
  if (!def) throw new AppError(`Unknown report "${key}".`, 404);
  const sid = Number(storeId);
  if (!Number.isInteger(sid) || sid <= 0) throw new AppError("Please select a store.");

  const { filters, applied } = parseFilters(def, query);
  let period = null;
  let range = null;
  if (def.period !== "none") {
    period = normalisePeriod(query.period, def.defaultPeriod || "THIS_MONTH");
    const r = getReportDateRange(period, query.fromDate, query.toDate);
    range = { from: r.fromDate, to: r.toDate, period };
  }

  const [store, result] = await Promise.all([loadStore(sid), def.query(sid, range, filters)]);
  const columns = resolveColumns(def, filters).map((c) => ({ align: ["money", "weight", "number", "percent"].includes(c.type) ? "right" : "left", ...c }));
  const rows = result.rows || [];
  const totals = result.totals || computeTotals(columns, rows);
  const generatedAt = new Date();

  let periodLabel;
  if (!range) periodLabel = `As on ${formatDate(generatedAt)}`;
  else if (period === "ALL") periodLabel = "All dates";
  else periodLabel = `${formatDate(range.from)} – ${formatDate(range.to)}`;

  return {
    key: def.key,
    name: def.name,
    group: def.group,
    description: def.description,
    orientation: def.orientation || "landscape",
    columns: columns.map(({ key: k, label, type, align, total, pdf, excel, repeat, width }) => ({ key: k, label, type, align, ...(total ? { total } : {}), ...(pdf === false ? { pdf } : {}), ...(excel === false ? { excel } : {}), ...(repeat === false ? { repeat } : {}), ...(width ? { width } : {}) })),
    rows,
    totals,
    totalsLabel: result.totalsLabel || "Total",
    summary: result.summary || [],
    meta: {
      store,
      period: period || "AS_ON",
      periodName: period ? periodName(period) : "As on date",
      periodLabel,
      from: range && period !== "ALL" ? istDateKey(range.from) : null,
      to: range && period !== "ALL" ? istDateKey(range.to) : istDateKey(generatedAt),
      generatedAt: generatedAt.toISOString(),
      rowCount: rows.filter((r) => !r._kind).length,
      filters: applied,
      notes: result.notes || [],
    },
  };
};
