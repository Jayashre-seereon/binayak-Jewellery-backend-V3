// Page engine for A4 business documents: letterhead, paginated tables with repeated
// headers, panels, footers ("Page x of y") and a CANCELLED watermark.
// Documents are rendered fully into memory and only then sent, so a rendering error
// can still be answered with a clean JSON error instead of a truncated PDF.
import PDFDocument from "pdfkit";
import { readFileSync } from "node:fs";
import { PDF_THEME } from "../pdfTemplate.js";

export const A4 = { width: 595.28, height: 841.89 };
export const MARGIN = 28;
export const CONTENT_WIDTH = A4.width - MARGIN * 2;
const FOOTER_SPACE = 30;

export const COLORS = {
  ...PDF_THEME,
  line: "#e6dcc4",
  hair: "#efe8d8",
  zebra: "#fbf8f1",
  panel: "#fcfaf5",
  goldTint: "#f5edd9",
  goldDark: "#9a7a2c",
  red: "#b42318",
  redTint: "#fdecea",
  green: "#067647",
  subtle: "#8a8f98",
};

const fontFile = (name) => {
  try {
    return readFileSync(new URL(`./fonts/${name}.ttf`, import.meta.url));
  } catch {
    return null;
  }
};

const FONT_FILES = {
  regular: fontFile("Carlito-Regular"),
  bold: fontFile("Carlito-Bold"),
  italic: fontFile("Carlito-Italic"),
  serif: fontFile("Caladea-Bold"),
};

const FALLBACK_FONTS = { regular: "Helvetica", bold: "Helvetica-Bold", italic: "Helvetica-Oblique", serif: "Times-Bold" };

let LOGO = null;
try {
  LOGO = readFileSync(new URL("../../utils/logo.png", import.meta.url));
} catch {
  LOGO = null;
}

export const registerFonts = (doc) => {
  const fonts = {};
  for (const [kind, buffer] of Object.entries(FONT_FILES)) {
    if (buffer) {
      try {
        doc.registerFont(`doc-${kind}`, buffer);
        fonts[kind] = `doc-${kind}`;
        continue;
      } catch {
        // fall through to the standard font
      }
    }
    fonts[kind] = FALLBACK_FONTS[kind];
  }
  // The rupee sign needs an embedded font; the PDF base-14 fonts have no glyph for it.
  fonts.rupee = fonts.regular.startsWith("doc-") ? "₹" : "Rs.";
  return fonts;
};

const renderToBuffer = (doc) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });

export const sendPdf = (res, buffer, filename, disposition = "inline") => {
  const safeName = String(filename || "document.pdf").replace(/[^A-Za-z0-9._-]+/g, "-");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", buffer.length);
  res.setHeader("Content-Disposition", `${disposition}; filename="${safeName}"`);
  res.end(buffer);
};

export class BusinessDocument {
  /**
   * @param {object} opts
   * @param {object} opts.brand        from documents/brand.js
   * @param {string} opts.title        e.g. "TAX INVOICE"
   * @param {string} [opts.copyLabel]  e.g. "ORIGINAL FOR RECIPIENT"
   * @param {Array<[string,string]>} [opts.identifiers] right-hand letterhead lines (GSTIN, PAN, CIN)
   * @param {string} [opts.reference]  document number shown on continuation pages and footer
   * @param {boolean} [opts.cancelled]
   */
  constructor({ brand, title, copyLabel = "", identifiers = [], reference = "", cancelled = false, footerNote = "" }) {
    this.brand = brand;
    this.title = title;
    this.copyLabel = copyLabel;
    this.identifiers = identifiers;
    this.reference = reference;
    this.cancelled = cancelled;
    this.footerNote = footerNote;
    this.doc = new PDFDocument({
      size: "A4",
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      bufferPages: true,
      autoFirstPage: true,
      info: { Title: `${title}${reference ? ` ${reference}` : ""}`, Author: brand.name, Creator: brand.name },
    });
    this.fonts = registerFonts(this.doc);
    this.rupee = this.fonts.rupee;
    this.x = MARGIN;
    this.width = CONTENT_WIDTH;
    this.right = MARGIN + CONTENT_WIDTH;
    this.bottom = A4.height - MARGIN - FOOTER_SPACE;
    this.y = MARGIN;
    this.onPageAdded = null;
    this.letterhead();
  }

  // ------------------------------------------------------------------ text
  use(kind = "regular", size = 8, color = COLORS.ink) {
    this.doc.font(this.fonts[kind] || this.fonts.regular).fontSize(size).fillColor(color);
    return this.doc;
  }

  measure(text, { kind = "regular", size = 8, spacing = 0 } = {}) {
    this.use(kind, size);
    return this.doc.widthOfString(String(text ?? ""), { characterSpacing: spacing });
  }

  fit(text, width, opts = {}) {
    let value = String(text ?? "");
    if (!width || this.measure(value, opts) <= width) return value;
    while (value.length > 1 && this.measure(`${value}…`, opts) > width) value = value.slice(0, -1);
    return `${value.trimEnd()}…`;
  }

  /** Greedy word wrap into at most `max` lines (the last one ellipsised). */
  splitLines(text, width, opts, max = 2) {
    const words = String(text ?? "").split(/\s+/).filter(Boolean);
    const lines = [];
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (!current || this.measure(next, opts) <= width) current = next;
      else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
    if (lines.length > max) {
      const head = lines.slice(0, max - 1);
      head.push(lines.slice(max - 1).join(" "));
      return head;
    }
    return lines.length ? lines : [""];
  }

  /** Lines a table cell will use (for row-height decisions). */
  lineCount(text, width, opts = {}) {
    return this.splitLines(text, width, opts, 2).length;
  }

  /** Single-line text, truncated with an ellipsis so it can never wrap or overflow. */
  write(text, x, y, { width, align = "left", kind = "regular", size = 8, color = COLORS.ink, spacing = 0 } = {}) {
    const value = width ? this.fit(text, width, { kind, size, spacing }) : String(text ?? "");
    this.use(kind, size, color);
    const options = { lineBreak: false, characterSpacing: spacing };
    if (width) {
      options.width = width;
      options.align = align;
    }
    this.doc.text(value, x, y, options);
  }

  heightOf(text, { width, kind = "regular", size = 8, lineGap = 1.5 } = {}) {
    this.use(kind, size);
    return this.doc.heightOfString(String(text ?? ""), { width, lineGap });
  }

  /** Wrapped paragraph; returns the height used. */
  paragraph(text, x, y, { width, kind = "regular", size = 8, color = COLORS.ink, lineGap = 1.5, align = "left" } = {}) {
    const h = this.heightOf(text, { width, kind, size, lineGap });
    this.use(kind, size, color);
    this.doc.text(String(text ?? ""), x, y, { width, lineGap, align });
    return h;
  }

  hline(x1, x2, y, { color = COLORS.line, width = 0.6 } = {}) {
    this.doc.save().moveTo(x1, y).lineTo(x2, y).lineWidth(width).strokeColor(color).stroke().restore();
  }

  box(x, y, w, h, { fill = COLORS.panel, stroke = COLORS.line, radius = 4, lineWidth = 0.7 } = {}) {
    const d = this.doc.save();
    d.roundedRect(x, y, w, h, radius).lineWidth(lineWidth);
    if (fill && stroke) d.fillAndStroke(fill, stroke);
    else if (fill) d.fill(fill);
    else d.strokeColor(stroke).stroke();
    d.restore();
  }

  sectionLabel(text, x, y, { width, color = COLORS.goldDark, align = "left" } = {}) {
    this.write(String(text).toUpperCase(), x, y, { width, kind: "bold", size: 6.6, color, spacing: 0.8, align });
  }

  // ------------------------------------------------------------------ pages
  letterhead() {
    const { doc, brand } = this;
    doc.save().rect(0, 0, A4.width, 5).fill(COLORS.navy).restore();
    doc.save().rect(0, 5, A4.width, 1.4).fill(COLORS.gold).restore();

    const top = MARGIN - 4;
    const logoSize = 50;
    if (LOGO) {
      try {
        doc.image(LOGO, this.x, top, { fit: [logoSize, logoSize] });
      } catch {
        // logo is decorative
      }
    }
    const textX = this.x + logoSize + 10;
    const leftWidth = 300;
    this.write(brand.name.toUpperCase(), textX, top + 2, { width: leftWidth, kind: "serif", size: 19, color: COLORS.navy, spacing: 0.6 });
    let ly = top + 26;
    if (brand.tagline) {
      this.write(brand.tagline, textX, ly, { width: leftWidth, kind: "italic", size: 8, color: COLORS.goldDark });
      ly += 11;
    }
    for (const line of brand.addressLines.slice(0, 2)) {
      this.write(line, textX, ly, { width: leftWidth, size: 7.8, color: COLORS.muted });
      ly += 10;
    }
    if (brand.phone) {
      this.write(`Phone: ${brand.phone}`, textX, ly, { width: leftWidth, size: 7.8, color: COLORS.muted });
      ly += 10;
    }

    let ry = top + 1;
    this.write(this.title, this.x, ry, { width: this.width, align: "right", kind: "bold", size: 15, color: COLORS.navy, spacing: 1.6 });
    ry += 19;
    if (this.copyLabel) {
      this.write(this.copyLabel.toUpperCase(), this.x, ry, { width: this.width, align: "right", kind: "bold", size: 6.5, color: COLORS.goldDark, spacing: 1 });
      ry += 11;
    }
    const valueCol = Math.min(150, Math.max(60, ...this.identifiers.map(([, v]) => this.measure(v || "-", { kind: "bold", size: 7.8 }))));
    for (const [label, value] of this.identifiers) {
      this.write(value || "-", this.right - valueCol, ry, { width: valueCol, align: "left", kind: "bold", size: 7.8, color: COLORS.ink });
      this.write(label, this.right - valueCol - 66, ry + 0.3, { width: 60, align: "right", size: 7.2, color: COLORS.muted, spacing: 0.3 });
      ry += 10.5;
    }

    const ruleY = Math.max(ly, ry, top + logoSize) + 6;
    this.hline(this.x, this.right, ruleY, { color: COLORS.navy, width: 1.1 });
    this.hline(this.x, this.right, ruleY + 2.2, { color: COLORS.gold, width: 0.6 });
    this.y = ruleY + 12;
  }

  continuationHeader() {
    const { doc } = this;
    doc.save().rect(0, 0, A4.width, 5).fill(COLORS.navy).restore();
    doc.save().rect(0, 5, A4.width, 1.4).fill(COLORS.gold).restore();
    const top = MARGIN - 6;
    this.write(this.brand.name.toUpperCase(), this.x, top, { width: 300, kind: "serif", size: 12, color: COLORS.navy, spacing: 0.4 });
    const right = [this.title, this.reference].filter(Boolean).join("  ·  ");
    this.write(right, this.x, top + 1, { width: this.width, align: "right", kind: "bold", size: 9, color: COLORS.navy, spacing: 0.6 });
    this.write("continued", this.x, top + 13, { width: this.width, align: "right", kind: "italic", size: 7, color: COLORS.muted });
    this.hline(this.x, this.right, top + 24, { color: COLORS.navy, width: 0.9 });
    this.hline(this.x, this.right, top + 26, { color: COLORS.gold, width: 0.5 });
    this.y = top + 34;
  }

  addPage() {
    this.doc.addPage({ size: "A4", margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    this.continuationHeader();
    if (typeof this.onPageAdded === "function") this.onPageAdded();
  }

  /** Starts a new page when `height` does not fit; returns true if a page was added. */
  ensure(height) {
    if (this.y + height <= this.bottom) return false;
    this.addPage();
    return true;
  }

  // ------------------------------------------------------------------ table
  tableHeader(columns, height = 24) {
    const { doc } = this;
    doc.save().rect(this.x, this.y, this.width, height).fill(COLORS.navy).restore();
    let cx = this.x;
    for (const col of columns) {
      const lines = String(col.label).split("\n");
      const lineH = 8;
      let ty = this.y + (height - lines.length * lineH) / 2 + 0.5;
      for (const line of lines) {
        this.write(line, cx + 3, ty, { width: col.width - 6, align: col.align || "left", kind: "bold", size: 6.7, color: COLORS.white, spacing: 0.2 });
        ty += lineH;
      }
      cx += col.width;
    }
    this.y += height;
  }

  /**
   * Draws a table that continues across pages with the header repeated.
   * A cell is a string or { text, sub, kind, color }.
   */
  table(columns, rows, { headerHeight = 24, rowHeight = 22, totals = null, zebra = true, mainSize = 7.6 } = {}) {
    const previous = this.onPageAdded;
    const heightOfRow = (row) => (typeof rowHeight === "function" ? rowHeight(row) : rowHeight);
    const lead = rows.slice(0, 2).reduce((s, row) => s + heightOfRow(row), 0) || 22;
    this.ensure(headerHeight + lead + (rows.length <= 2 && totals ? 18 : 0));
    this.tableHeader(columns, headerHeight);
    rows.forEach((row, index) => {
      const rh = typeof rowHeight === "function" ? rowHeight(row) : rowHeight;
      const reserve = index === rows.length - 1 && totals ? 18 : 0;
      if (this.y + rh + reserve > this.bottom - 12) {
        this.write("Continued on next page", this.x, this.y + 4, { width: this.width, align: "right", kind: "italic", size: 7, color: COLORS.muted });
        this.addPage();
        this.tableHeader(columns, headerHeight);
      }
      if (zebra && index % 2 === 1) this.doc.save().rect(this.x, this.y, this.width, rh).fill(COLORS.zebra).restore();
      let cx = this.x;
      for (const col of columns) {
        const raw = row[col.key];
        const cell = raw !== null && typeof raw === "object" ? raw : { text: raw };
        const hasSub = cell.sub !== undefined && cell.sub !== null && cell.sub !== "";
        const textOpts = { width: col.width - 6, align: col.align || "left", kind: cell.kind || col.kind || "regular", size: mainSize, color: cell.color || COLORS.ink };
        const mainLines = col.wrap ? this.splitLines(cell.text ?? "", col.width - 6, textOpts, 2) : [String(cell.text ?? "")];
        const blockH = mainLines.length * (mainSize + 1.6) + (hasSub ? 8.2 : 0);
        let mainY = this.y + (rh - blockH) / 2 + 0.6;
        for (const text of mainLines) {
          this.write(text, cx + 3, mainY, textOpts);
          mainY += mainSize + 1.6;
        }
        if (hasSub) {
          this.write(cell.sub, cx + 3, mainY + 0.6, {
            width: col.width - 6,
            align: col.align || "left",
            size: 6.1,
            color: cell.subColor || COLORS.subtle,
          });
        }
        cx += col.width;
      }
      this.y += rh;
      this.hline(this.x, this.right, this.y, { color: COLORS.hair, width: 0.5 });
    });

    if (totals) {
      const th = 18;
      this.ensure(th);
      this.doc.save().rect(this.x, this.y, this.width, th).fill(COLORS.goldTint).restore();
      this.hline(this.x, this.right, this.y, { color: COLORS.navy, width: 0.8 });
      let cx = this.x;
      for (const col of columns) {
        const value = totals[col.key];
        if (value !== undefined && value !== null && value !== "") {
          this.write(value, cx + 3, this.y + 5.2, { width: col.width - 6, align: col.align || "left", kind: "bold", size: mainSize, color: COLORS.navy });
        }
        cx += col.width;
      }
      this.y += th;
      this.hline(this.x, this.right, this.y, { color: COLORS.navy, width: 0.8 });
    }
    this.onPageAdded = previous;
  }

  // ------------------------------------------------------------------ blocks
  /** Label/value rows inside a column; returns the height used. */
  keyValues(pairs, x, y, { width, labelWidth = 70, size = 7.8, gap = 11.5 } = {}) {
    let cy = y;
    for (const [label, value, opts = {}] of pairs) {
      this.write(label, x, cy, { width: labelWidth - 4, size: size - 0.4, color: COLORS.muted });
      const valueWidth = width - labelWidth;
      if (opts.wrap) {
        const h = this.paragraph(value || "-", x + labelWidth, cy, { width: valueWidth, size, kind: opts.kind || "regular", color: opts.color || COLORS.ink, lineGap: 1 });
        cy += Math.max(gap, h + 2.5);
      } else {
        this.write(value || "-", x + labelWidth, cy, { width: valueWidth, size, kind: opts.kind || "regular", color: opts.color || COLORS.ink });
        cy += gap;
      }
    }
    return cy - y;
  }

  stamp(text, x, y, { color = COLORS.red, size = 11 } = {}) {
    const w = this.measure(text, { kind: "bold", size, spacing: 1.5 }) + 16;
    const h = size + 9;
    this.doc.save().roundedRect(x - w, y, w, h, 3).lineWidth(1.4).strokeColor(color).stroke().restore();
    this.write(text, x - w, y + 4.8, { width: w, align: "center", kind: "bold", size, color, spacing: 1.5 });
    return h;
  }

  signatureBlocks(labels, { height = 46 } = {}) {
    this.ensure(height + 6);
    const count = labels.length;
    const gap = 18;
    const w = (this.width - gap * (count - 1)) / count;
    const lineY = this.y + height - 12;
    labels.forEach((entry, index) => {
      const { label, caption = "", align = index === count - 1 ? "right" : index === 0 ? "left" : "center" } = typeof entry === "string" ? { label: entry } : entry;
      const x = this.x + index * (w + gap);
      if (caption) this.write(caption, x, this.y + 2, { width: w, align, kind: "bold", size: 7.6, color: COLORS.navy });
      this.hline(x, x + w, lineY, { color: COLORS.muted, width: 0.6 });
      this.write(label, x, lineY + 3, { width: w, align, size: 7.2, color: COLORS.muted });
    });
    this.y += height;
  }

  // ------------------------------------------------------------------ finish
  decoratePages() {
    const { doc } = this;
    const range = doc.bufferedPageRange();
    const total = range.count;
    for (let i = range.start; i < range.start + total; i += 1) {
      doc.switchToPage(i);
      if (this.cancelled) {
        doc.save();
        doc.rotate(-33, { origin: [A4.width / 2, A4.height / 2] });
        doc.fillOpacity(0.1);
        this.use("bold", 104, COLORS.red);
        doc.text("CANCELLED", 0, A4.height / 2 - 52, { width: A4.width, align: "center", lineBreak: false, characterSpacing: 6 });
        doc.restore();
        doc.fillOpacity(1);
      }
      const fy = A4.height - MARGIN - 14;
      this.hline(this.x, this.right, fy, { color: COLORS.gold, width: 0.6 });
      const note = this.footerNote || "This is a computer-generated document.";
      this.write(note, this.x, fy + 5, { width: this.width * 0.6, size: 6.8, kind: "italic", color: COLORS.muted });
      const right = `${this.reference ? `${this.reference}  ·  ` : ""}Page ${i - range.start + 1} of ${total}`;
      this.write(right, this.x, fy + 5, { width: this.width, align: "right", size: 6.8, color: COLORS.muted });
    }
  }

  async toBuffer() {
    this.decoratePages();
    return renderToBuffer(this.doc);
  }
}
