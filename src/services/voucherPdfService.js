import { numberToWordsIndian } from "../utils/numberToWords.js";
import { loadBrand } from "./documents/brand.js";
import { BusinessDocument, COLORS, sendPdf } from "./documents/engine.js";
import { clean, dash, inr, istDateTime, labelize, num, panFromGstin, titleCase, upper } from "./documents/format.js";

const TITLES = { RECEIPT: "RECEIPT VOUCHER", PAYMENT: "PAYMENT VOUCHER", JOURNAL: "JOURNAL VOUCHER", CONTRA: "CONTRA VOUCHER" };

const REFERENCE_LABELS = {
  SALE_INVOICE: "Sale invoice",
  SALE: "Sale invoice",
  PURCHASE: "Purchase",
  ADVANCE: "Customer advance",
  OTHER: "Other",
  RetailInvoice: "Retail invoice (migrated)",
  OldMetalPurchase: "Old metal purchase (migrated)",
  AdvanceReceive: "Advance receipt (migrated)",
};

const referenceText = (v) => {
  const type = clean(v.referenceType);
  const label = REFERENCE_LABELS[type] || titleCase(type);
  const doc =
    clean(v.referenceDocNo) ||
    clean(v.sale?.invoiceNo) ||
    clean(v.purchase?.invoiceNo) ||
    (v.advanceReceiveId ? `Advance #${v.advanceReceiveId}` : "");
  return [label, doc].filter(Boolean).join(" · ") || "-";
};

const partyOf = (v) => {
  const customer = v.customer || {};
  const party = v.party || {};
  const advance = v.advanceReceive || {};
  const gstin = upper(party.gst) || upper(customer.gst);
  return {
    name: upper(v.partyName) || upper(customer.name) || upper(party.name) || upper(advance.customerName) || upper(v.sale?.customerName) || upper(v.purchase?.customerName),
    phone: clean(v.partyPhone) || clean(customer.phone) || clean(party.phone) || clean(advance.contactNumber),
    address: clean(customer.address) || clean(party.address) || clean(advance.address),
    gstin,
    pan: upper(customer.pan) || panFromGstin(gstin),
  };
};

export const buildVoucherPdf = async (voucher) => {
  const brand = await loadBrand(voucher.store?.id ? voucher.store : voucher.storeId);
  const type = upper(voucher.voucherType);
  const title = TITLES[type] || `${labelize(type).toUpperCase() || "ACCOUNTING"} VOUCHER`;
  const cancelled = upper(voucher.status) === "CANCELLED";
  const pdf = new BusinessDocument({
    brand,
    title,
    copyLabel: type === "RECEIPT" ? "Customer Copy" : "",
    identifiers: [["GSTIN", brand.gstin || "-"], ["PAN", brand.pan || "-"]],
    reference: clean(voucher.voucherNo),
    cancelled,
    footerNote: brand.tagline ? `${brand.tagline}  ·  This is a computer-generated voucher.` : "This is a computer-generated voucher.",
  });
  const R = pdf.rupee;

  if (cancelled) {
    const reason = clean(voucher.cancelledReason);
    const text = `CANCELLED${voucher.cancelledAt ? ` on ${istDateTime(voucher.cancelledAt)}` : ""}${reason ? `  —  Reason: ${reason}` : ""}`;
    pdf.box(pdf.x, pdf.y, pdf.width, 20, { fill: COLORS.redTint, stroke: COLORS.red, radius: 3 });
    pdf.write(text, pdf.x + 10, pdf.y + 6, { width: pdf.width - 20, kind: "bold", size: 8.4, color: COLORS.red, spacing: 0.3 });
    pdf.y += 28;
  }

  // ------------------------------------------------------------ panels
  const party = partyOf(voucher);
  const gap = 12;
  const leftW = 300;
  const rightW = pdf.width - leftW - gap;
  const partyTitle = type === "RECEIPT" ? "Received From" : type === "PAYMENT" ? "Paid To" : "Party";
  const partyPairs = [
    ["Name", party.name || "-", { kind: "bold" }],
    ["Phone", party.phone || "-"],
    ["Address", party.address || "-", { wrap: true }],
    ["GSTIN", party.gstin || "-"],
    ["PAN", party.pan || "-"],
  ];
  const mode = upper(voucher.paymentMode);
  const details = [
    ["Voucher No.", dash(voucher.voucherNo), { kind: "bold" }],
    ["Date", istDateTime(voucher.date)],
    ["Payment Mode", mode ? (mode === "UPI" ? "UPI" : titleCase(mode)) : "-"],
    ["Reference", referenceText(voucher)],
    ["Bank", dash(voucher.bankName)],
    ["Transaction Ref.", dash(voucher.transactionRef)],
    ["Prepared By", dash(voucher.createdBy)],
    ["Status", cancelled ? "CANCELLED" : titleCase(voucher.status) || "-", cancelled ? { kind: "bold", color: COLORS.red } : {}],
  ];
  const measureKv = (pairs, width, labelWidth) =>
    pairs.reduce((h, [, v, o = {}]) => h + (o.wrap ? Math.max(11.5, pdf.heightOf(v, { width: width - labelWidth, size: 7.8, lineGap: 1 }) + 2.5) : 11.5), 0);
  const panelTop = pdf.y;
  const panelH = Math.max(measureKv(partyPairs, leftW - 20, 62), measureKv(details, rightW - 20, 82)) + 24;
  pdf.box(pdf.x, panelTop, leftW, panelH);
  pdf.box(pdf.x + leftW + gap, panelTop, rightW, panelH);
  pdf.sectionLabel(partyTitle, pdf.x + 10, panelTop + 8);
  pdf.sectionLabel("Voucher Details", pdf.x + leftW + gap + 10, panelTop + 8);
  pdf.keyValues(partyPairs, pdf.x + 10, panelTop + 20, { width: leftW - 20, labelWidth: 62 });
  pdf.keyValues(details, pdf.x + leftW + gap + 10, panelTop + 20, { width: rightW - 20, labelWidth: 82 });
  pdf.y = panelTop + panelH + 12;

  // ------------------------------------------------------------ amount band
  const entries = voucher.entries || [];
  const totalDebit = entries.reduce((s, e) => s + num(e.debit), 0);
  const totalCredit = entries.reduce((s, e) => s + num(e.credit), 0);
  const amount = num(voucher.amount) || totalDebit;
  const words = numberToWordsIndian(amount);
  const bandH = Math.max(46, pdf.heightOf(words, { width: pdf.width - 198, kind: "bold", size: 9, lineGap: 1 }) + 30);
  pdf.doc.save().roundedRect(pdf.x, pdf.y, pdf.width, bandH, 4).fill(COLORS.navy).restore();
  pdf.doc.save().rect(pdf.x + 170, pdf.y + 8, 0.8, bandH - 16).fill(COLORS.gold).restore();
  const amountLabel = type === "RECEIPT" ? "Amount Received" : type === "PAYMENT" ? "Amount Paid" : "Voucher Amount";
  pdf.write(amountLabel.toUpperCase(), pdf.x + 14, pdf.y + 10, { width: 150, kind: "bold", size: 6.8, color: COLORS.goldLight, spacing: 1 });
  pdf.write(`${R} ${inr(amount)}`, pdf.x + 14, pdf.y + 21, { width: 150, kind: "bold", size: 16, color: COLORS.white });
  pdf.write("IN WORDS", pdf.x + 184, pdf.y + 10, { width: pdf.width - 198, kind: "bold", size: 6.8, color: COLORS.goldLight, spacing: 1 });
  pdf.paragraph(words, pdf.x + 184, pdf.y + 21, { width: pdf.width - 198, kind: "bold", size: 9, color: COLORS.white, lineGap: 1 });
  pdf.y += bandH + 14;

  // ------------------------------------------------------------ ledger entries (paginated)
  pdf.sectionLabel("Accounting Entries", pdf.x, pdf.y);
  pdf.y += 11;
  const hasParticulars = entries.some((e) => clean(e.narration));
  const columns = [
    { key: "sr", label: "#", width: 22, align: "center" },
    { key: "account", label: "Account", width: hasParticulars ? 200 : 337, wrap: true },
  ];
  if (hasParticulars) columns.push({ key: "particulars", label: "Particulars", width: 137, wrap: true });
  columns.push(
    { key: "debit", label: `Debit (${R})`, width: 90, align: "right" },
    { key: "credit", label: `Credit (${R})`, width: pdf.width - 22 - 337 - 90, align: "right" }
  );
  const accountCol = columns[1];
  const particularsCol = columns.find((c) => c.key === "particulars");
  const tall = (row) =>
    (row.account?.text && pdf.lineCount(row.account.text, accountCol.width - 6, { kind: "bold", size: 7.6 }) > 1) ||
    (particularsCol && typeof row.particulars === "string" && pdf.lineCount(row.particulars, particularsCol.width - 6, { size: 7.6 }) > 1);
  const rows = entries.map((e, i) => ({
    sr: String(i + 1),
    account: { text: clean(e.accountName) || "-", kind: "bold", sub: num(e.debit) > 0 ? "Dr" : num(e.credit) > 0 ? "Cr" : "" },
    particulars: clean(e.narration) || "-",
    debit: num(e.debit) > 0 ? inr(e.debit) : "-",
    credit: num(e.credit) > 0 ? inr(e.credit) : "-",
  }));
  pdf.table(columns, rows.length ? rows : [{ account: { text: "No ledger entries recorded for this voucher", kind: "italic" } }], {
    headerHeight: 20,
    rowHeight: (row) => (tall(row) ? 30 : 22),
    totals: { account: `Total (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`, debit: inr(totalDebit), credit: inr(totalCredit) },
  });
  pdf.y += 12;

  if (clean(voucher.narration)) {
    const text = clean(voucher.narration);
    const h = pdf.heightOf(text, { width: pdf.width - 16, size: 8, lineGap: 1.2 }) + 22;
    pdf.ensure(h + 4);
    pdf.box(pdf.x, pdf.y, pdf.width, h, { fill: COLORS.panel });
    pdf.sectionLabel("Narration", pdf.x + 8, pdf.y + 7);
    pdf.paragraph(text, pdf.x + 8, pdf.y + 17, { width: pdf.width - 16, size: 8, lineGap: 1.2 });
    pdf.y += h + 12;
  }

  pdf.y += 8;
  const signatures =
    type === "RECEIPT"
      ? [{ label: "Payer's Signature" }, { label: "Cashier / Received By" }, { label: "Authorised Signatory", caption: `For ${brand.name.toUpperCase()}` }]
      : type === "PAYMENT"
        ? [{ label: "Receiver's Signature" }, { label: "Prepared By" }, { label: "Authorised Signatory", caption: `For ${brand.name.toUpperCase()}` }]
        : [{ label: "Prepared By" }, { label: "Checked By" }, { label: "Authorised Signatory", caption: `For ${brand.name.toUpperCase()}` }];
  pdf.signatureBlocks(signatures);

  return pdf.toBuffer();
};

export const generateVoucherPdf = async (voucher, res) => {
  const buffer = await buildVoucherPdf(voucher);
  const title = (TITLES[upper(voucher.voucherType)] || "VOUCHER").replace(/ /g, "-");
  sendPdf(res, buffer, `${title}-${voucher.voucherNo || voucher.id}.pdf`);
};
