// Item-code labels (MRP goods): one label per PDF page, page size = label size (default 50 × 25 mm),
// which is what thermal label printers (203/300 dpi, roll media) expect.
import PDFDocument from "pdfkit";
import bwipjs from "bwip-js";
import { isValidEan13, pickSymbology } from "./symbology.js";

const MM = 72 / 25.4; // PDF points per millimetre
const BWIP_ID = { CODE128: "code128", EAN13: "ean13", QRCODE: "qrcode" };

/** Shortens text with an ellipsis so it fits `width` at the current font/size. */
const fit = (doc, text, width) => {
  let s = String(text ?? "");
  if (doc.widthOfString(s) <= width) return s;
  while (s.length > 1 && doc.widthOfString(`${s}…`) > width) s = s.slice(0, -1);
  return `${s}…`;
};

const renderBars = (code, symbology) => {
  const opts = { bcid: BWIP_ID[symbology], text: code, scale: 4, backgroundcolor: "FFFFFF" };
  if (symbology === "QRCODE") opts.eclevel = "M";
  else opts.height = 10;
  return bwipjs.toBuffer(opts);
};

/**
 * @param {object} p
 * @param {string} p.code        barcode value
 * @param {string} p.storeName
 * @param {string} p.itemName
 * @param {string} [p.subtitle]  e.g. "GOLD 22K"
 * @param {number} [p.copies=1]
 * @param {object} [p.config]    BarcodeConfig (labelWidthMm, labelHeightMm, symbology)
 * @returns {Promise<Buffer>}
 */
export const buildItemLabelPdf = async ({ code, storeName, itemName, subtitle, copies = 1, config = {} }) => {
  const productName = itemName;
  const width = Number(config.labelWidthMm || 50) * MM;
  const height = Number(config.labelHeightMm || 25) * MM;
  // EAN-13 values print as EAN-13 unless the store prefers QR; anything else is Code 128.
  const symbology = config.symbology === "QRCODE" ? "QRCODE" : pickSymbology(code, isValidEan13(code) ? "AUTO" : "CODE128");
  const bars = await renderBars(code, symbology);

  const doc = new PDFDocument({ size: [width, height], margin: 0, autoFirstPage: false, info: { Title: `Barcode labels ${code}` } });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const pad = 1.2 * MM;
  const inner = width - pad * 2;
  const headerLine = [productName, subtitle].filter(Boolean).join(" · ");

  for (let i = 0; i < copies; i += 1) {
    doc.addPage({ size: [width, height], margin: 0 });
    doc.fillColor("#000000");

    if (symbology === "QRCODE") {
      // QR on the left (square), text block on the right.
      const side = height - pad * 2;
      doc.image(bars, pad, pad, { fit: [side, side] });
      const tx = pad + side + pad;
      const tw = width - tx - pad;
      doc.font("Helvetica-Bold").fontSize(6.5).text(fit(doc, storeName, tw), tx, pad + 1, { lineBreak: false });
      doc.font("Helvetica").fontSize(6).text(fit(doc, productName, tw), tx, pad + 10, { lineBreak: false });
      if (subtitle) doc.text(fit(doc, subtitle, tw), tx, pad + 18, { lineBreak: false });
      doc.font("Helvetica-Bold").fontSize(6.5).text(fit(doc, code, tw), tx, height - pad - 8, { lineBreak: false });
      continue;
    }

    // Store name (bold) and product line, centred.
    doc.font("Helvetica-Bold").fontSize(6.5);
    const store = fit(doc, storeName, inner);
    doc.text(store, pad + (inner - doc.widthOfString(store)) / 2, pad, { lineBreak: false });

    doc.font("Helvetica").fontSize(6);
    const line = fit(doc, headerLine, inner);
    doc.text(line, pad + (inner - doc.widthOfString(line)) / 2, pad + 7.5, { lineBreak: false });

    // Bars fill the middle band; human-readable text underneath.
    const barTop = pad + 15;
    const textH = 7.5;
    const barH = height - barTop - pad - textH;
    // Keep ~2 mm quiet zone on each side so scanners find the start/stop patterns.
    const quiet = 2 * MM;
    doc.image(bars, pad + quiet, barTop, { fit: [inner - quiet * 2, barH], align: "center", valign: "center" });

    doc.font("Helvetica-Bold").fontSize(7);
    const human = fit(doc, code, inner);
    doc.text(human, pad + (inner - doc.widthOfString(human)) / 2, height - pad - textH + 0.5, { lineBreak: false });
  }

  doc.end();
  return done;
};
