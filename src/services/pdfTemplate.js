import PDFDocument from "pdfkit";
import { readFileSync } from "node:fs";

const LOGO_IMAGE = readFileSync(new URL("../utils/logo.png", import.meta.url));

export const PDF_THEME = {
  navy: "#1f2357",
  navyDeep: "#171a44",
  gold: "#c9a24a",
  goldLight: "#f3e2b0",
  ink: "#1f2937",
  muted: "#6b7280",
  border: "#d6c7a1",
  soft: "#faf7ef",
  white: "#ffffff",
};

export const PDF_PAGE = {
  width: 595.28,
  height: 841.89,
  margin: 20,
};

export const createPdfDoc = () =>
  new PDFDocument({
    size: "A4",
    margins: {
      top: PDF_PAGE.margin,
      bottom: PDF_PAGE.margin,
      left: PDF_PAGE.margin,
      right: PDF_PAGE.margin,
    },
    bufferPages: true,
    autoFirstPage: true,
  });

export const headerBrand = (storeName = "BINAYAK JEWELLERS") => String(storeName || "BINAYAK JEWELLERS").toUpperCase();

export const drawGoldHeader = (doc, { title, branchName, storeName, tagline, y = PDF_PAGE.margin } = {}) => {
  const x = PDF_PAGE.margin;
  const width = PDF_PAGE.width - PDF_PAGE.margin * 2;
  const headerH = 72;

  doc.save();
  doc.rect(x, y, width, headerH).fill(PDF_THEME.navy);
  doc.rect(x, y, 14, headerH).fill(PDF_THEME.gold);
  doc.rect(x + width - 14, y, 14, headerH).fill(PDF_THEME.gold);
  doc.restore();

  const logoX = x + 12;
  const logoY = y + 12;
  doc.save().circle(logoX + 24, logoY + 24, 24).fillAndStroke(PDF_THEME.white, PDF_THEME.gold);
  try {
    doc.image(LOGO_IMAGE, logoX + 6, logoY + 6, { fit: [36, 36], align: "center", valign: "center" });
  } catch {
    doc.fillColor(PDF_THEME.navyDeep).font("Helvetica-Bold").fontSize(18).text("BJ", logoX + 8, logoY + 17, { width: 32, align: "center" });
  }
  doc.restore();

  doc.fillColor(PDF_THEME.white).font("Helvetica-Bold").fontSize(16).text(headerBrand(storeName), x + 72, y + 14, { width: 286 });
  if (tagline) {
    doc.fillColor("#f7e9c7").font("Helvetica-Oblique").fontSize(7.5).text(tagline, x + 72, y + 34, { width: 296 });
  }

  const badgeX = x + width - 66;
  const badgeY = y + 12;
  doc.save().circle(badgeX + 24, badgeY + 24, 24).fillAndStroke(PDF_THEME.white, PDF_THEME.goldLight);
  doc.fillColor(PDF_THEME.navyDeep).font("Helvetica-Bold").fontSize(8.5).text("SINCE", badgeX + 8, badgeY + 9, { width: 32, align: "center" });
  doc.fontSize(13).text("2010", badgeX + 4, badgeY + 19, { width: 40, align: "center" });
  doc.fontSize(5.5).text("TRUSTED", badgeX + 5, badgeY + 36, { width: 38, align: "center" });
  doc.restore();

  const secondY = y + headerH + 8;
  doc.fillColor(PDF_THEME.ink).font("Helvetica-Bold").fontSize(11).text(String(title || "").toUpperCase(), x + 18, secondY);
  if (branchName) {
    doc.font("Helvetica").fontSize(7.5).fillColor(PDF_THEME.muted).text(branchName, x + 18, secondY + 13);
  }

  doc.moveTo(x, secondY + 22).lineTo(x + width, secondY + 22).lineWidth(0.6).strokeColor(PDF_THEME.border).stroke();
  return secondY + 30;
};

export const drawFooter = (doc, text, y) => {
  const x = PDF_PAGE.margin;
  const width = PDF_PAGE.width - PDF_PAGE.margin * 2;
  doc.moveTo(x, y).lineTo(x + width, y).lineWidth(0.8).strokeColor(PDF_THEME.gold).stroke();
  doc.fillColor(PDF_THEME.muted).font("Helvetica-Oblique").fontSize(7.2).text(text, x, y + 8, { width, align: "center" });
};
