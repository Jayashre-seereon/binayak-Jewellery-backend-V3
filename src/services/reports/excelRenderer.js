// Excel version of a report: title block, KPI block, frozen header, typed number formats,
// auto-filter, group/subtotal styling and a totals row — same columns as the PDF (plus detail columns).
import ExcelJS from "exceljs";
import { COLORS, formatCell, formatDateTime } from "./theme.js";

const argb = (hex) => `FF${String(hex).replace("#", "").toUpperCase()}`;
// "#,##0" follows the viewer's regional digit grouping, so Indian-locale Excel shows 1,23,456.
const NUM_FMT = {
  money: '"₹" #,##0.00;[Red]-"₹" #,##0.00',
  weight: "#,##0.000",
  number: "#,##0",
  percent: '0.00"%"',
  date: "dd-mmm-yyyy",
};

export const sheetName = (name) =>
  String(name || "Report")
    .replace(/[\\/*?:[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 31) || "Report";

const toExcelDate = (v) => {
  const m = typeof v === "string" && v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return null;
};

const cellValue = (v, type) => {
  if (v === null || v === undefined || v === "") return null;
  if (type === "date") return toExcelDate(v) || formatCell(v, "date");
  if (type === "money" || type === "weight" || type === "number" || type === "percent") {
    const n = Number(v);
    return Number.isFinite(n) ? n : String(v);
  }
  return String(v);
};

const thin = (color = COLORS.rule) => ({ style: "thin", color: { argb: argb(color) } });

export const renderReportExcel = async (report) => {
  const store = report.meta?.store || {};
  const columns = (report.columns || []).filter((c) => c.excel !== false);
  const rows = report.rows || [];
  const nCols = Math.max(columns.length, 2);

  const wb = new ExcelJS.Workbook();
  wb.creator = store.storeName || "Jewellery ERP";
  wb.company = store.storeName || "";
  wb.title = report.name;
  wb.created = new Date();

  const ws = wb.addWorksheet(sheetName(report.name), {
    pageSetup: {
      paperSize: 9,
      orientation: report.orientation === "portrait" ? "portrait" : "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.3, footer: 0.3 },
    },
    headerFooter: { oddFooter: `&L${(store.storeName || "").replace(/&/g, "&&")} · ${report.name.replace(/&/g, "&&")}&RPage &P of &N` },
    properties: { defaultRowHeight: 17 },
  });

  const merge = (r) => ws.mergeCells(r, 1, r, nCols);
  let r = 1;

  // ---- title block
  ws.getRow(r).values = [String(store.storeName || "").toUpperCase()];
  merge(r);
  ws.getRow(r).height = 26;
  Object.assign(ws.getCell(r, 1), {
    font: { name: "Calibri", size: 16, bold: true, color: { argb: argb(COLORS.white) } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: argb(COLORS.navy) } },
    alignment: { vertical: "middle", horizontal: "left", indent: 1 },
  });
  r += 1;
  const address = [store.address, store.city, store.location, store.state].filter((x) => x && String(x).trim()).join(", ");
  const ids = [address, store.gstNo ? `GSTIN ${store.gstNo}` : null, store.phone ? `Ph ${store.phone}` : null].filter(Boolean).join("   ·   ");
  ws.getRow(r).values = [ids];
  merge(r);
  Object.assign(ws.getCell(r, 1), {
    font: { name: "Calibri", size: 9.5, color: { argb: argb(COLORS.goldLight) } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: argb(COLORS.navy) } },
    alignment: { vertical: "middle", horizontal: "left", indent: 1 },
    border: { bottom: { style: "medium", color: { argb: argb(COLORS.gold) } } },
  });
  r += 2;
  ws.getRow(r).values = [report.name];
  merge(r);
  ws.getRow(r).height = 22;
  ws.getCell(r, 1).font = { name: "Calibri", size: 15, bold: true, color: { argb: argb(COLORS.navy) } };
  r += 1;
  ws.getRow(r).values = [`Period: ${report.meta?.periodLabel || ""}      Generated: ${formatDateTime(new Date(report.meta?.generatedAt || Date.now()))}`];
  merge(r);
  ws.getCell(r, 1).font = { name: "Calibri", size: 10, color: { argb: argb(COLORS.muted) } };
  r += 1;
  const filters = (report.meta?.filters || []).map((f) => `${f.label}: ${f.value}`).join("   ·   ");
  if (filters) {
    ws.getRow(r).values = [`Filters: ${filters}`];
    merge(r);
    ws.getCell(r, 1).font = { name: "Calibri", size: 10, color: { argb: argb(COLORS.ink) } };
    r += 1;
  }
  for (const note of report.meta?.notes || []) {
    ws.getRow(r).values = [note];
    merge(r);
    ws.getRow(r).height = 30;
    Object.assign(ws.getCell(r, 1), {
      font: { name: "Calibri", size: 9.5, italic: true, color: { argb: argb(COLORS.ink) } },
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDF7E7" } },
      alignment: { wrapText: true, vertical: "middle", indent: 1 },
    });
    r += 1;
  }

  // ---- KPI block: label / value pairs laid out across the sheet
  const cards = report.summary || [];
  if (cards.length) {
    r += 1;
    // wide sheets: each card spans two columns; narrow sheets: one column per card
    const span = nCols >= 8 ? 2 : 1;
    const pairsPerRow = Math.max(1, Math.floor(nCols / span));
    for (let i = 0; i < cards.length; i += pairsPerRow) {
      const labelRow = ws.getRow(r);
      const valueRow = ws.getRow(r + 1);
      cards.slice(i, i + pairsPerRow).forEach((c, j) => {
        const col = j * span + 1;
        if (span > 1) {
          ws.mergeCells(r, col, r, col + 1);
          ws.mergeCells(r + 1, col, r + 1, col + 1);
        }
        const lc = labelRow.getCell(col);
        lc.value = String(c.label).toUpperCase();
        lc.font = { name: "Calibri", size: 8.5, bold: true, color: { argb: argb(COLORS.muted) } };
        lc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(COLORS.cardFill) } };
        lc.border = { top: thin(COLORS.gold), left: thin(), right: thin() };
        const vc = valueRow.getCell(col);
        const v = c.type === "text" ? String(c.value ?? "") : cellValue(c.value, c.type);
        vc.value = v;
        if (NUM_FMT[c.type] && typeof v !== "string") vc.numFmt = NUM_FMT[c.type];
        vc.font = { name: "Calibri", size: 13, bold: true, color: { argb: argb(COLORS.navy) } };
        vc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(COLORS.cardFill) } };
        vc.alignment = { horizontal: "left" };
        vc.border = { bottom: thin(), left: thin(), right: thin() };
      });
      valueRow.height = 22;
      r += 3;
    }
  } else {
    r += 1;
  }

  // ---- table
  const headerRowNo = r;
  const header = ws.getRow(headerRowNo);
  columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.label;
    cell.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: argb(COLORS.white) } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(COLORS.navyDeep) } };
    cell.alignment = { vertical: "middle", horizontal: c.align === "right" ? "right" : c.align === "center" ? "center" : "left", wrapText: true };
    cell.border = { bottom: { style: "medium", color: { argb: argb(COLORS.gold) } }, right: thin("#3a3f7a") };
  });
  header.height = 30;
  r += 1;

  const widths = columns.map((c) => Math.min(Math.max(String(c.label).length + 2, c.type === "money" ? 14 : c.type === "date" ? 12 : 8), 40));
  const firstNumeric = Math.max(1, columns.findIndex((c) => ["money", "weight", "number", "percent"].includes(c.type)));
  let zebra = 0;
  const firstData = r;
  for (const row of rows) {
    const xr = ws.getRow(r);
    if (row._kind === "group") {
      xr.getCell(1).value = String(row._label || "").toUpperCase();
      for (let i = 1; i <= columns.length; i += 1) {
        const cell = xr.getCell(i);
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(COLORS.groupFill) } };
        cell.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: argb(COLORS.navy) } };
      }
      r += 1;
      zebra = 0;
      continue;
    }
    columns.forEach((c, i) => {
      const cell = xr.getCell(i + 1);
      let v = cellValue(row[c.key], c.type);
      if (row._kind === "subtotal" && i === 0) v = row._label || v;
      if (row._kind === "subtotal" && i > 0 && i < firstNumeric && c.type !== "date") v = null;
      cell.value = v;
      if (NUM_FMT[c.type] && v !== null && typeof v !== "string") cell.numFmt = NUM_FMT[c.type];
      if (c.align === "center") cell.alignment = { horizontal: "center" };
      if (v !== null && typeof v === "string") widths[i] = Math.min(Math.max(widths[i], v.length + 2), c.type === "text" ? 48 : 22);
      else if (typeof v === "number") widths[i] = Math.min(Math.max(widths[i], formatCell(v, c.type).length + 2), 22);
    });
    if (row._kind === "subtotal") {
      for (let i = 1; i <= columns.length; i += 1) {
        const cell = xr.getCell(i);
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(row._strong ? "#f1e3bd" : COLORS.subtotalFill) } };
        cell.font = { name: "Calibri", bold: true, color: { argb: argb(row._warn ? COLORS.danger : COLORS.navyDeep) } };
        cell.border = { top: thin(COLORS.gold) };
      }
      zebra = 0;
    } else {
      if (zebra % 2 === 1) for (let i = 1; i <= columns.length; i += 1) xr.getCell(i).fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(COLORS.zebra) } };
      zebra += 1;
    }
    r += 1;
  }
  if (!rows.length) {
    ws.getRow(r).getCell(1).value = "No records for the selected period and filters.";
    ws.getRow(r).getCell(1).font = { italic: true, color: { argb: argb(COLORS.muted) } };
    r += 1;
  }
  const lastData = r - 1;

  const totals = report.totals || {};
  if (rows.length && Object.keys(totals).length) {
    const tr = ws.getRow(r);
    columns.forEach((c, i) => {
      const cell = tr.getCell(i + 1);
      if (i === 0) cell.value = String(report.totalsLabel || "Total").toUpperCase();
      else if (totals[c.key] !== undefined) {
        cell.value = cellValue(totals[c.key], c.type);
        if (NUM_FMT[c.type]) cell.numFmt = NUM_FMT[c.type];
      }
      cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: argb(i === 0 ? COLORS.goldLight : COLORS.white) } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(COLORS.navy) } };
      cell.border = { top: { style: "medium", color: { argb: argb(COLORS.gold) } } };
      if (c.align === "center") cell.alignment = { horizontal: "center" };
    });
    tr.height = 21;
    r += 1;
  }

  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });
  ws.views = [{ state: "frozen", ySplit: headerRowNo, xSplit: 0, topLeftCell: `A${headerRowNo + 1}`, showGridLines: false }];
  if (rows.length && columns.length) ws.autoFilter = { from: { row: headerRowNo, column: 1 }, to: { row: Math.max(lastData, firstData), column: columns.length } };
  ws.pageSetup.printTitlesRow = `${headerRowNo}:${headerRowNo}`;

  return Buffer.from(await wb.xlsx.writeBuffer());
};
