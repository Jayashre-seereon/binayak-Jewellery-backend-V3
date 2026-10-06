// Branded A4 report PDF: store header, title/period, KPI cards, a fitted table with repeated
// header, zebra rows, group/subtotal lines, totals row, and "Page X of Y" footers.
import PDFDocument from "pdfkit";
import { COLORS, LOGO, registerFonts, formatCell, formatDate, formatDateTime, isNumericType } from "./theme.js";

const PAGE = {
  portrait: { w: 595.28, h: 841.89 },
  landscape: { w: 841.89, h: 595.28 },
};
const M = { side: 26, top: 24, bottom: 34 };
const PAD = 5; // cell padding (each side)
const MIN_TEXT_W = 54;
const MAX_TEXT_W = 230;

// ---------------------------------------------------------------- fast text measuring
// pdfkit's widthOfString runs full shaping on every call; for tables with thousands of rows we
// measure with cached per-character advances instead (kerning is irrelevant for fitting).
const makeMeasurer = (doc) => {
  const caches = new Map();
  return (str, font, size) => {
    let cache = caches.get(font);
    if (!cache) {
      cache = new Map();
      caches.set(font, cache);
    }
    let w = 0;
    for (const ch of String(str)) {
      let a = cache.get(ch);
      if (a === undefined) {
        doc.font(font).fontSize(100);
        a = doc.widthOfString(ch) / 100;
        cache.set(ch, a);
      }
      w += a;
    }
    return w * size;
  };
};

const ELLIPSIS = "…";
const fitText = (measure, str, font, size, maxW) => {
  if (!str) return "";
  if (measure(str, font, size) <= maxW) return str;
  const ell = measure(ELLIPSIS, font, size);
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(str.slice(0, mid), font, size) + ell <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${str.slice(0, lo).trimEnd()}${ELLIPSIS}` : ELLIPSIS;
};

/** Greedy word wrap into at most `maxLines` lines. */
const wrap = (measure, str, font, size, maxW, maxLines = 2) => {
  const words = String(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (measure(t, font, size) <= maxW || !cur) cur = t;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1);
    head.push(fitText(measure, lines.slice(maxLines - 1).join(" "), font, size, maxW));
    return head;
  }
  return lines.map((l) => fitText(measure, l, font, size, maxW));
};

// ---------------------------------------------------------------- column fitting
const FIXED_TYPES = new Set(["money", "weight", "number", "percent", "date"]);
// identifier-like text columns are never truncated either (an invoice number with "…" is useless)
const CODE_KEYS = new Set(["invoiceNo", "voucherNo", "docNo", "tagNo", "barcodeNo", "inventoryCode", "receiptNo", "hsn", "phone", "huidNo"]);
const isFixedCol = (c) => FIXED_TYPES.has(c.type) || CODE_KEYS.has(c.key) || c.fixed === true;
const MIN_SAMPLE = { money: "₹ 00,000.00", weight: "000.000", number: "000" };

const cellText = (row, col) => formatCell(row[col.key], col.type);

const fitColumns = ({ measure, F, columns, rows, totals, width }) => {
  // Widths scale linearly with font size, so measure every cell once at size 1.
  const unit = columns.map((c) => {
    const words = String(c.label).split(/\s+/);
    const longestWord = Math.max(...words.map((w) => measure(w, F.bodyBold, 1)));
    let content = 0;
    for (const r of rows) {
      if (r._kind === "group") continue;
      const t = cellText(r, c);
      if (t) content = Math.max(content, measure(t, r._kind ? F.bodyBold : F.body, 1));
    }
    if (totals && totals[c.key] !== undefined) content = Math.max(content, measure(formatCell(totals[c.key], c.type), F.bodyBold, 1));
    if (MIN_SAMPLE[c.type]) content = Math.max(content, measure(MIN_SAMPLE[c.type], F.body, 1));
    return { longestWord, half: measure(c.label, F.bodyBold, 1) / 2, content };
  });
  const isFixed = columns.map(isFixedCol);
  let chosen = null;
  const oneLine = 8.2 * unit.reduce((s, u) => s + Math.max(u.half * 2, u.content), 0) + PAD * 2 * unit.length <= width;
  for (const size of [8.2, 7.8, 7.4, 7, 6.6, 6.2]) {
    const nat = unit.map((u) => Math.ceil(Math.max(u.longestWord * size, oneLine ? u.half * 2 * size : u.half * size + 4, u.content * size) + PAD * 2));
    const fixedSum = nat.reduce((s, w, i) => s + (isFixed[i] ? w : 0), 0);
    const textMin = nat.reduce((s, w, i) => s + (isFixed[i] ? 0 : Math.min(w, MIN_TEXT_W)), 0);
    chosen = { size, nat, isFixed };
    if (fixedSum + textMin <= width) break;
  }
  const { size, nat } = chosen;
  const widths = nat.map((w, i) => (isFixed[i] ? w : Math.min(w, MAX_TEXT_W)));
  let sum = widths.reduce((a, b) => a + b, 0);
  const textIdx = widths.map((_, i) => i).filter((i) => !isFixed[i]);
  if (sum <= width) {
    // spread the spare width: text columns first (they read better wide), else everything
    // (weighted by width², so long names/particulars get the room rather than phone/code columns)
    const grow = textIdx.length ? textIdx : widths.map((_, i) => i);
    const base = grow.reduce((s, i) => s + widths[i] ** 2, 0) || 1;
    const extra = width - sum;
    grow.forEach((i) => {
      widths[i] += (extra * widths[i] ** 2) / base;
    });
  } else {
    // shrink text columns (water-filling) so numbers keep their full width
    const fixed = widths.reduce((s, w, i) => s + (isFixed[i] ? w : 0), 0);
    let avail = Math.max(width - fixed, textIdx.length * 20);
    let open = [...textIdx];
    const target = {};
    while (open.length) {
      const share = avail / open.length;
      const small = open.filter((i) => widths[i] <= share);
      if (!small.length) {
        open.forEach((i) => {
          target[i] = share;
        });
        break;
      }
      small.forEach((i) => {
        target[i] = widths[i];
        avail -= widths[i];
      });
      open = open.filter((i) => !small.includes(i));
    }
    textIdx.forEach((i) => {
      widths[i] = target[i];
    });
    sum = widths.reduce((a, b) => a + b, 0);
    if (sum > width) {
      const k = width / sum; // last resort: scale everything (font already at minimum)
      for (let i = 0; i < widths.length; i += 1) widths[i] *= k;
    }
  }
  return { size, widths };
};

// ---------------------------------------------------------------- drawing helpers
const drawText = (doc, str, x, y, font, size, color, opts = {}) => {
  doc.font(font).fontSize(size).fillColor(color);
  doc.text(str, x, y, { lineBreak: false, characterSpacing: opts.spacing || 0 });
};

const drawRight = (doc, measure, str, right, y, font, size, color, spacing = 0) => {
  const w = measure(str, font, size) + spacing * Math.max(0, String(str).length - 1);
  drawText(doc, str, right - w, y, font, size, color, { spacing });
};

const drawLogo = (doc, cx, cy, r) => {
  doc.save();
  doc.circle(cx, cy, r).fill(COLORS.white);
  doc.circle(cx, cy, r).lineWidth(1.2).strokeColor(COLORS.gold).stroke();
  if (LOGO) {
    try {
      doc.image(LOGO, cx - r * 0.72, cy - r * 0.72, { fit: [r * 1.44, r * 1.44], align: "center", valign: "center" });
    } catch {
      /* logo is decorative */
    }
  }
  doc.restore();
};

// ---------------------------------------------------------------- main renderer
export const renderReportPdf = (report) =>
  new Promise((resolve, reject) => {
    const orientation = report.orientation === "portrait" ? "portrait" : "landscape";
    const { w: W, h: H } = PAGE[orientation];
    const doc = new PDFDocument({ size: "A4", layout: orientation, margins: { top: 0, bottom: 0, left: 0, right: 0 }, bufferPages: true, autoFirstPage: true, info: { Title: report.name, Author: report.meta?.store?.storeName || "Jewellery ERP", Subject: report.meta?.periodLabel || "" } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      const F = registerFonts(doc);
      const measure = makeMeasurer(doc);
      const store = report.meta?.store || {};
      const storeName = String(store.storeName || "Jewellery Store").toUpperCase();
      const left = M.side;
      const contentW = W - M.side * 2;
      const right = left + contentW;
      const bottomLimit = H - M.bottom - 6;

      const columns = (report.columns || []).filter((c) => c.pdf !== false);
      const rows = report.rows || [];
      const totals = report.totals && Object.keys(report.totals).length ? report.totals : null;

      // ---------- first-page header
      const drawFullHeader = () => {
        const y0 = M.top;
        const bandH = 66;
        doc.save();
        doc.rect(left, y0, contentW, bandH).fill(COLORS.navy);
        doc.rect(left, y0 + bandH - 2.5, contentW, 2.5).fill(COLORS.gold);
        doc.rect(left + 4, y0 + 4, contentW - 8, bandH - 10.5).lineWidth(0.5).strokeColor("#3a3f7a").stroke();
        doc.restore();
        drawLogo(doc, left + 36, y0 + bandH / 2 - 1, 22);
        const tx = left + 68;
        const maxNameW = contentW * 0.58;
        let nameSize = 17;
        while (nameSize > 11 && measure(storeName, F.display, nameSize) + 1.2 * storeName.length > maxNameW) nameSize -= 0.5;
        drawText(doc, storeName, tx, y0 + 11, F.display, nameSize, COLORS.white, { spacing: 1.2 });
        const address = [store.address, store.city, store.location, store.state].filter((x) => x && String(x).trim()).join(", ");
        const tagline = store.tagline && !/^x+$/i.test(String(store.tagline).trim()) ? String(store.tagline).trim() : "";
        const sub = address || tagline;
        if (sub) drawText(doc, fitText(measure, sub, F.body, 8.8, maxNameW), tx, y0 + 34, F.body, 8.8, COLORS.goldLight);
        // right block: document type + statutory / contact details
        const groupLabel = `${String(report.group || "").toUpperCase()} REPORT`;
        drawRight(doc, measure, groupLabel, right - 16, y0 + 13, F.bodyBold, 7.6, COLORS.gold, 1.6);
        const contact = [
          store.gstNo ? `GSTIN  ${store.gstNo}` : null,
          store.phone ? `Phone  ${store.phone}` : null,
          store.email && !/\.test$/i.test(store.email) ? store.email : null,
        ].filter(Boolean);
        contact.slice(0, 3).forEach((line, i) => drawRight(doc, measure, line, right - 16, y0 + 26 + i * 11, i === 0 ? F.bodyBold : F.body, 8.6, i === 0 ? COLORS.white : "#cfd2e6"));

        let y = y0 + bandH + 14;
        // title line
        drawText(doc, report.name, left, y, F.display, 15, COLORS.navy);
        const genText = `Generated ${formatDateTime(new Date(report.meta?.generatedAt || Date.now()))}`;
        drawRight(doc, measure, "PERIOD", right, y + 1, F.bodyBold, 6.8, COLORS.muted, 1.2);
        drawRight(doc, measure, report.meta?.periodLabel || "", right, y + 10, F.bodyBold, 9.5, COLORS.ink);
        y += 22;
        const desc = fitText(measure, report.description || "", F.body, 8.6, contentW * 0.62);
        if (desc) drawText(doc, desc, left, y, F.body, 8.6, COLORS.muted);
        drawRight(doc, measure, genText, right, y + 1, F.body, 7.8, COLORS.muted);
        y += 13;
        const filters = (report.meta?.filters || []).map((f) => `${f.label}: ${f.value}`).join("    ·    ");
        if (filters) {
          drawText(doc, fitText(measure, `Filters   ${filters}`, F.body, 7.8, contentW), left, y, F.body, 7.8, COLORS.ink);
          y += 12;
        }
        y += 3;
        doc.moveTo(left, y).lineTo(right, y).lineWidth(0.7).strokeColor(COLORS.border).stroke();
        y += 10;

        // KPI cards
        const cards = report.summary || [];
        if (cards.length) {
          const maxPerRow = orientation === "landscape" ? 7 : 4;
          const perRow = cards.length <= maxPerRow ? cards.length : Math.ceil(cards.length / Math.ceil(cards.length / maxPerRow));
          const gap = 8;
          const cw = (contentW - gap * (perRow - 1)) / perRow;
          const ch = 42;
          cards.forEach((c, i) => {
            const cx = left + (i % perRow) * (cw + gap);
            const cy = y + Math.floor(i / perRow) * (ch + gap);
            doc.save();
            doc.roundedRect(cx, cy, cw, ch, 4).fill(COLORS.cardFill);
            doc.roundedRect(cx, cy, cw, ch, 4).lineWidth(0.6).strokeColor(COLORS.rule).stroke();
            doc.rect(cx, cy + 6, 2.6, ch - 12).fill(COLORS.gold);
            doc.restore();
            const label = fitText(measure, String(c.label).toUpperCase(), F.bodyBold, 6.9, cw - 18);
            drawText(doc, label, cx + 10, cy + 8, F.bodyBold, 6.9, COLORS.muted, { spacing: 0.5 });
            const value = c.type === "text" ? String(c.value ?? "—") : formatCell(c.value, c.type) || (c.type === "date" ? "—" : "0");
            let vs = 12.5;
            while (vs > 7.5 && measure(value, F.displayMedium, vs) > cw - 18) vs -= 0.5;
            drawText(doc, fitText(measure, value, F.displayMedium, vs, cw - 18), cx + 10, cy + 20, F.displayMedium, vs, COLORS.navy);
          });
          y += Math.ceil(cards.length / perRow) * (ch + gap) + 2;
        }

        // notes
        for (const note of report.meta?.notes || []) {
          doc.font(F.body).fontSize(8);
          const h = doc.heightOfString(note, { width: contentW - 22 }) + 10;
          doc.save();
          doc.rect(left, y, contentW, h).fill("#fdf7e7");
          doc.rect(left, y, 2.6, h).fill(COLORS.gold);
          doc.restore();
          doc.fillColor(COLORS.ink).text(note, left + 12, y + 5, { width: contentW - 22 });
          y += h + 6;
        }
        return y + 2;
      };

      const drawSlimHeader = () => {
        const y0 = M.top;
        const h = 28;
        doc.save();
        doc.rect(left, y0, contentW, h).fill(COLORS.navy);
        doc.rect(left, y0 + h - 2, contentW, 2).fill(COLORS.gold);
        doc.restore();
        drawText(doc, storeName, left + 12, y0 + 8, F.display, 9.5, COLORS.white, { spacing: 0.8 });
        drawRight(doc, measure, `${report.name}   ·   ${report.meta?.periodLabel || ""}`, right - 12, y0 + 9, F.body, 8.4, COLORS.goldLight);
        return y0 + h + 10;
      };

      // ---------- table geometry
      const { size: fs, widths } = fitColumns({ measure, F, columns, rows, totals, width: contentW });
      const xs = [];
      widths.reduce((x, w, i) => {
        xs[i] = x;
        return x + w;
      }, left);
      const rowH = Math.round(fs * 1.95 * 10) / 10;
      const textY = (y, h) => y + (h - fs * 1.18) / 2 + 0.3;
      const headerLines = columns.map((c, i) => wrap(measure, c.label, F.bodyBold, fs, widths[i] - PAD * 2, 2));
      const headH = Math.max(...headerLines.map((l) => l.length), 1) > 1 ? fs * 2 * 1.2 + 9 : fs * 1.2 + 11;

      const drawTableHeader = (y) => {
        doc.save();
        doc.rect(left, y, contentW, headH).fill(COLORS.navyDeep);
        doc.rect(left, y + headH - 1.4, contentW, 1.4).fill(COLORS.gold);
        doc.restore();
        columns.forEach((c, i) => {
          const lines = headerLines[i];
          const blockH = lines.length * fs * 1.2;
          let ly = y + (headH - 1.4 - blockH) / 2 + 0.5;
          for (const line of lines) {
            const lw = measure(line, F.bodyBold, fs);
            const x = c.align === "right" ? xs[i] + widths[i] - PAD - lw : c.align === "center" ? xs[i] + (widths[i] - lw) / 2 : xs[i] + PAD;
            drawText(doc, line, x, ly, F.bodyBold, fs, COLORS.white);
            ly += fs * 1.2;
          }
        });
        return y + headH;
      };

      const drawCell = (str, i, y, h, font, color) => {
        if (!str) return;
        const c = columns[i];
        const maxW = widths[i] - PAD * 2;
        const t = FIXED_TYPES.has(c.type) ? str : fitText(measure, str, font, fs, maxW + (isFixedCol(c) ? 1 : 0));
        const tw = measure(t, font, fs);
        const x = c.align === "right" ? xs[i] + widths[i] - PAD - tw : c.align === "center" ? xs[i] + (widths[i] - tw) / 2 : xs[i] + PAD;
        drawText(doc, t, x, textY(y, h), font, fs, color);
      };

      /** label of a subtotal/total row spans the leading non-numeric columns */
      const labelSpan = () => {
        let k = 0;
        while (k < columns.length && !isNumericType(columns[k].type)) k += 1;
        return Math.max(k, 1);
      };
      const span = labelSpan();

      let y = drawFullHeader();
      let page = 1;
      const newPage = () => {
        doc.addPage({ size: "A4", layout: orientation, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        page += 1;
        y = drawSlimHeader();
        y = drawTableHeader(y);
      };

      // keep the header with at least a few rows
      if (y + headH + rowH * 3 > bottomLimit) {
        doc.addPage({ size: "A4", layout: orientation, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        page += 1;
        y = drawSlimHeader();
      }
      y = drawTableHeader(y);

      if (!rows.length) {
        doc.save();
        doc.rect(left, y, contentW, 46).fill(COLORS.zebra);
        doc.restore();
        const msg = "No records for the selected period and filters.";
        drawText(doc, msg, left + (contentW - measure(msg, F.body, 9.5)) / 2, y + 17, F.body, 9.5, COLORS.muted);
        y += 46;
      }

      let zebra = 0;
      let prevRow = null;
      for (const r of rows) {
        const kind = r._kind;
        const h = kind === "group" ? rowH + 3 : kind === "subtotal" ? rowH + 1.5 : rowH;
        // a group header must not be orphaned at the bottom of a page
        const need = kind === "group" ? h + rowH * 2 : h;
        if (y + need > bottomLimit) {
          newPage();
          zebra = 0;
          prevRow = null;
        }
        if (kind === "group") {
          doc.save();
          doc.rect(left, y, contentW, h).fill(COLORS.groupFill);
          doc.rect(left, y, 2.6, h).fill(COLORS.gold);
          doc.restore();
          drawText(doc, fitText(measure, String(r._label || "").toUpperCase(), F.bodyBold, fs + 0.4, contentW - 20), left + PAD + 6, textY(y, h), F.bodyBold, fs + 0.4, COLORS.navy, { spacing: 0.6 });
          y += h;
          zebra = 0;
          prevRow = null;
          continue;
        }
        if (kind === "subtotal") {
          doc.save();
          doc.rect(left, y, contentW, h).fill(r._strong ? "#f1e3bd" : COLORS.subtotalFill);
          doc.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor(COLORS.gold).stroke();
          doc.restore();
          const color = r._warn ? COLORS.danger : COLORS.navyDeep;
          const spanW = xs[span - 1] + widths[span - 1] - left - PAD * 2;
          // date-like first cell (cash book opening/closing) prints before the label
          let label = String(r._label || "");
          if (r.date && columns[0]?.type === "date") label = `${formatDate(r.date)}   ${label}`;
          drawText(doc, fitText(measure, label, F.bodyBold, fs, spanW), left + PAD, textY(y, h), F.bodyBold, fs, color);
          columns.forEach((c, i) => {
            if (i < span) return;
            const zero = (c.type === "money" || c.type === "weight") && r[c.key] !== undefined && r[c.key] !== null && Math.abs(Number(r[c.key])) < 0.0005;
            drawCell(zero ? "–" : formatCell(r[c.key], c.type), i, y, h, zero ? F.body : F.bodyBold, zero ? COLORS.muted : color);
          });
          y += h;
          zebra = 0;
          prevRow = null;
          continue;
        }
        if (r._cont) zebra -= 1; // lines of one voucher share a shade
        if (zebra % 2 === 1) {
          doc.save();
          doc.rect(left, y, contentW, h).fill(COLORS.zebra);
          doc.restore();
        }
        columns.forEach((c, i) => {
          let str = cellText(r, c);
          let color = c.key === "status" && /cancel/i.test(str) ? COLORS.danger : COLORS.ink;
          if (r._cont && (c.key === "date" || c.key === "voucherNo" || c.key === "type")) str = "";
          if (c.repeat === false && prevRow && prevRow[c.key] === r[c.key]) str = "";
          if ((c.type === "money" || c.type === "weight") && str && Math.abs(Number(r[c.key])) < 0.0005) {
            str = "–";
            color = COLORS.muted;
          }
          drawCell(str, i, y, h, F.body, color);
        });
        doc.moveTo(left, y + h).lineTo(right, y + h).lineWidth(0.25).strokeColor(COLORS.rule).stroke();
        y += h;
        zebra += 1;
        prevRow = r;
      }

      // totals row
      if (totals && rows.length) {
        const h = rowH + 5;
        if (y + h + 2 > bottomLimit) newPage();
        y += 2;
        doc.save();
        doc.rect(left, y, contentW, h).fill(COLORS.navy);
        doc.rect(left, y, contentW, 1.4).fill(COLORS.gold);
        doc.restore();
        const spanW = xs[span - 1] + widths[span - 1] - left - PAD * 2;
        drawText(doc, fitText(measure, String(report.totalsLabel || "Total").toUpperCase(), F.bodyBold, fs, spanW), left + PAD, textY(y, h) + 0.6, F.bodyBold, fs, COLORS.goldLight, { spacing: 0.8 });
        columns.forEach((c, i) => {
          if (i < span || totals[c.key] === undefined) return;
          drawCell(formatCell(totals[c.key], c.type), i, y + 0.6, h, F.bodyBold, COLORS.white);
        });
        y += h;
      }

      // end mark
      if (y + 16 <= bottomLimit) {
        const end = `${report.meta?.rowCount ?? rows.length} record${(report.meta?.rowCount ?? rows.length) === 1 ? "" : "s"}  ·  end of report`;
        drawText(doc, end, left + (contentW - measure(end, F.body, 7.4)) / 2, y + 8, F.body, 7.4, COLORS.muted);
      }

      // footers (page X of Y)
      const range = doc.bufferedPageRange();
      const total = range.count;
      for (let p = 0; p < total; p += 1) {
        doc.switchToPage(range.start + p);
        const fy = H - M.bottom + 8;
        doc.moveTo(left, fy).lineTo(right, fy).lineWidth(0.6).strokeColor(COLORS.gold).stroke();
        const leftText = fitText(measure, `${store.storeName || ""}  ·  ${report.name}`, F.body, 7.4, contentW * 0.4);
        drawText(doc, leftText, left, fy + 6, F.body, 7.4, COLORS.muted);
        const mid = "Computer-generated report";
        drawText(doc, mid, left + (contentW - measure(mid, F.body, 7.4)) / 2, fy + 6, F.body, 7.4, COLORS.muted);
        drawRight(doc, measure, `Page ${p + 1} of ${total}`, right, fy + 6, F.bodyBold, 7.4, COLORS.navy);
      }
      void page;
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
