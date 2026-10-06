// Reusable blocks drawn on a BusinessDocument: compact tables, totals box, words box,
// HSN-wise tax summary.
import { COLORS } from "./engine.js";
import { inr, num, round2 } from "./format.js";

const MINI = { headerH: 15, rowH: 13.5, size: 7.2 };

export const miniTableHeight = (rowCount, { totals = false, headerH = MINI.headerH, rowH = MINI.rowH } = {}) =>
  headerH + rowCount * rowH + (totals ? rowH + 1 : 0);

/** Small bordered table that is never split (callers reserve its height first). */
export const miniTable = (pdf, x, y, columns, rows, { totals = null, headerH = MINI.headerH, rowH = MINI.rowH, size = MINI.size } = {}) => {
  const width = columns.reduce((s, c) => s + c.width, 0);
  const height = miniTableHeight(rows.length, { totals: Boolean(totals), headerH, rowH });
  pdf.doc.save().roundedRect(x, y, width, height, 3).lineWidth(0.6).strokeColor(COLORS.line).stroke().restore();
  pdf.doc.save().rect(x + 0.3, y + 0.3, width - 0.6, headerH - 0.3).fill(COLORS.goldTint).restore();
  let cx = x;
  for (const col of columns) {
    pdf.write(col.label, cx + 3, y + (headerH - 6.4) / 2, { width: col.width - 6, align: col.align || "left", kind: "bold", size: 6.4, color: COLORS.navy, spacing: 0.2 });
    cx += col.width;
  }
  let cy = y + headerH;
  rows.forEach((row) => {
    cx = x;
    for (const col of columns) {
      pdf.write(row[col.key] ?? "", cx + 3, cy + (rowH - size) / 2 - 0.4, { width: col.width - 6, align: col.align || "left", size, color: COLORS.ink });
      cx += col.width;
    }
    cy += rowH;
    pdf.hline(x, x + width, cy, { color: COLORS.hair, width: 0.4 });
  });
  if (totals) {
    pdf.hline(x, x + width, cy, { color: COLORS.navy, width: 0.6 });
    cx = x;
    for (const col of columns) {
      if (totals[col.key] !== undefined) {
        pdf.write(totals[col.key], cx + 3, cy + (rowH - size) / 2 + 0.2, { width: col.width - 6, align: col.align || "left", kind: "bold", size, color: COLORS.navy });
      }
      cx += col.width;
    }
  }
  return height;
};

const LINE_H = { normal: 12.6, strong: 13.6, muted: 12, grand: 24, due: 16, rule: 5 };

export const totalsHeight = (lines) => lines.reduce((s, l) => s + (LINE_H[l.kind || "normal"] || LINE_H.normal), 0) + 10;

/**
 * Totals box. Each line: { label, value, kind: normal|strong|muted|grand|due|rule, color }.
 * Values are pre-formatted strings.
 */
export const totalsBox = (pdf, x, y, width, lines) => {
  const height = totalsHeight(lines);
  pdf.box(x, y, width, height, { fill: COLORS.panel, stroke: COLORS.line, radius: 4 });
  let cy = y + 5;
  const padX = 9;
  for (const line of lines) {
    const kind = line.kind || "normal";
    const h = LINE_H[kind] || LINE_H.normal;
    if (kind === "rule") {
      pdf.hline(x + padX, x + width - padX, cy + 2.5, { color: COLORS.line, width: 0.6 });
    } else if (kind === "grand") {
      pdf.doc.save().rect(x + 0.4, cy + 1, width - 0.8, h - 3).fill(COLORS.navy).restore();
      pdf.write(line.label, x + padX, cy + 7.4, { width: width * 0.55, kind: "bold", size: 8.6, color: COLORS.white, spacing: 0.6 });
      pdf.write(line.value, x + padX, cy + 6.2, { width: width - padX * 2, align: "right", kind: "bold", size: 10.5, color: COLORS.goldLight });
    } else {
      const strong = kind === "strong" || kind === "due";
      const size = kind === "due" ? 9 : kind === "muted" ? 7.2 : 7.8;
      const color = line.color || (kind === "muted" ? COLORS.muted : COLORS.ink);
      const ty = cy + (h - size) / 2 - 0.4;
      pdf.write(line.label, x + padX, ty, { width: width * 0.62, kind: strong ? "bold" : "regular", size, color });
      pdf.write(line.value, x + padX, ty, { width: width - padX * 2, align: "right", kind: strong ? "bold" : "regular", size, color });
    }
    cy += h;
  }
  return height;
};

export const wordsBoxHeight = (pdf, words, width) => 17 + pdf.heightOf(words, { width: width - 16, kind: "bold", size: 8, lineGap: 1 });

export const wordsBox = (pdf, x, y, width, label, words) => {
  const height = wordsBoxHeight(pdf, words, width);
  pdf.box(x, y, width, height, { fill: COLORS.white, stroke: COLORS.line, radius: 4 });
  pdf.doc.save().rect(x, y + 3, 2.4, height - 6).fill(COLORS.gold).restore();
  pdf.sectionLabel(label, x + 8, y + 5, { width: width - 16 });
  pdf.paragraph(words, x + 8, y + 13.5, { width: width - 16, kind: "bold", size: 8, color: COLORS.navy, lineGap: 1 });
  return height;
};

/**
 * HSN-wise summary built from stored amounts. Line taxes are used when they were stored
 * (migrated invoices); otherwise invoice-level CGST/SGST/IGST is allocated by taxable share
 * with the rounding remainder on the last row so the columns add up to the invoice.
 */
export const buildHsnSummary = (lines, { taxable, cgst, sgst, igst, cgstRate, sgstRate, igstRate }) => {
  const groups = new Map();
  for (const line of lines) {
    const key = line.hsn || "-";
    const g = groups.get(key) || { hsn: key, base: 0, cgst: 0, sgst: 0, igst: 0 };
    g.base += num(line.amount);
    g.cgst += num(line.cgst);
    g.sgst += num(line.sgst);
    g.igst += num(line.igst);
    groups.set(key, g);
  }
  const rows = [...groups.values()];
  const baseTotal = rows.reduce((s, r) => s + r.base, 0);
  const share = (r) => (baseTotal > 0 ? r.base / baseTotal : 1 / rows.length);
  const allocate = (field, total) => {
    let left = round2(total);
    rows.forEach((r, i) => {
      const value = i === rows.length - 1 ? left : round2(total * share(r));
      r[field] = value;
      left = round2(left - value);
    });
  };
  const lineTaxMatches = (field, total) => Math.abs(rows.reduce((s, r) => s + r[field], 0) - total) < 0.05;
  allocate("taxable", taxable);
  for (const [field, total] of [["cgst", cgst], ["sgst", sgst], ["igst", igst]]) {
    if (total > 0 && lineTaxMatches(field, total)) {
      // keep the stored line split, but make the column add up to the invoice exactly
      let left = round2(total);
      rows.forEach((r, i) => {
        r[field] = i === rows.length - 1 ? left : round2(r[field]);
        left = round2(left - r[field]);
      });
    } else {
      allocate(field, total);
    }
  }
  return {
    rows: rows.map((r) => ({ ...r, tax: round2(r.cgst + r.sgst + r.igst) })),
    showCgst: cgst !== 0 || sgst !== 0,
    showIgst: igst !== 0,
    rates: { cgstRate, sgstRate, igstRate },
  };
};

const pct = (v) => `${Number(num(v).toFixed(3)).toString()}%`;

/** Columns/rows for miniTable from buildHsnSummary output (fits `width`). */
export const hsnTableSpec = (summary, width) => {
  const { showCgst, showIgst, rates } = summary;
  const cols = [{ key: "hsn", label: "HSN/SAC", align: "left", w: 1.05 }, { key: "taxable", label: "Taxable Value", align: "right", w: 1.45 }];
  if (showCgst) {
    cols.push({ key: "cgstRate", label: "CGST %", align: "right", w: 0.75 }, { key: "cgst", label: "CGST", align: "right", w: 1.1 });
    cols.push({ key: "sgstRate", label: "SGST %", align: "right", w: 0.75 }, { key: "sgst", label: "SGST", align: "right", w: 1.1 });
  }
  if (showIgst) cols.push({ key: "igstRate", label: "IGST %", align: "right", w: 0.75 }, { key: "igst", label: "IGST", align: "right", w: 1.1 });
  cols.push({ key: "tax", label: "Total Tax", align: "right", w: 1.2 });
  const unit = width / cols.reduce((s, c) => s + c.w, 0);
  let used = 0;
  const columns = cols.map((c, i) => {
    const w = i === cols.length - 1 ? width - used : Math.floor(c.w * unit);
    used += w;
    return { key: c.key, label: c.label, align: c.align, width: w };
  });
  const rows = summary.rows.map((r) => ({
    hsn: r.hsn,
    taxable: inr(r.taxable),
    cgstRate: pct(rates.cgstRate),
    cgst: inr(r.cgst),
    sgstRate: pct(rates.sgstRate),
    sgst: inr(r.sgst),
    igstRate: pct(rates.igstRate),
    igst: inr(r.igst),
    tax: inr(r.tax),
  }));
  const sum = (f) => inr(summary.rows.reduce((s, r) => s + num(r[f]), 0));
  const totals = rows.length > 1 ? { hsn: "Total", taxable: sum("taxable"), cgst: sum("cgst"), sgst: sum("sgst"), igst: sum("igst"), tax: sum("tax") } : null;
  return { columns, rows, totals };
};
