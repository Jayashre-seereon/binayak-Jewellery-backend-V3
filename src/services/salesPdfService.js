import prisma from "../config/db.js";
import { numberToWordsIndian } from "../utils/numberToWords.js";
import { AppError } from "../utils/validate.js";
import { publicStoreSelect } from "../utils/publicSelect.js";
import { buildBrand } from "./documents/brand.js";
import { BusinessDocument, COLORS, sendPdf } from "./documents/engine.js";
import { buildHsnSummary, hsnTableSpec, miniTable, miniTableHeight, totalsBox, totalsHeight, wordsBox, wordsBoxHeight } from "./documents/blocks.js";
import { clean, dash, hasTime, inr, istDate, istDateTime, istTime, num, rateText, stateWithCode, titleCase, upper, weight } from "./documents/format.js";

const LEGACY_PARTICULARS = /^net\s*wt\b/i;

const pick = (...values) => {
  for (const v of values) if (num(v) !== 0) return num(v);
  return 0;
};

const purityLabel = (item, inv) => {
  const name = clean(item.purityName) || clean(inv?.purityMaster?.name) || (num(item.purity) > 0 ? String(item.purity) : "");
  return name ? name.replace(/\s*carats?$/i, "K").replace(/^(\d+)\s+K$/i, "$1K") : "-";
};

const makingSub = (item, rupee) => {
  const rate = num(item.makingChargeRate);
  const type = upper(item.makingChargeType);
  if (rate <= 0) return "";
  if (type === "PERCENT") return `@ ${rateText(rate)}%`;
  if (type === "PER_GRAM") return `@ ${rupee}${rateText(rate)}/g`;
  return "Flat";
};

const paymentDetails = (p, saleDate) => {
  const parts = [];
  const channel = clean(p.paymentChannel);
  if (channel && channel.toUpperCase() !== String(p.paymentMode || "").toUpperCase()) parts.push(channel);
  const txn = clean(p.transactionId);
  const ref = clean(p.referenceNo);
  if (txn) parts.push(`Txn ${txn}`);
  if (ref && ref !== txn) parts.push(`Ref ${ref}`);
  const note = clean(p.description) || clean(p.narration);
  if (note) parts.push(note);
  if (p.paymentDate && saleDate && istDate(p.paymentDate) !== istDate(saleDate)) parts.push(`on ${istDate(p.paymentDate)}`);
  return parts.join(" · ") || "-";
};

const loadSale = (id, storeId) =>
  prisma.sale.findFirst({
    where: { id: Number(id), storeId: Number(storeId) },
    include: {
      store: { select: publicStoreSelect },
      party: true,
      customer: true,
      items: {
        orderBy: { id: "asc" },
        include: { inventory: { include: { item: true, product: true, purityMaster: true, metal: true } } },
      },
      payments: { orderBy: [{ paymentDate: "asc" }, { id: "asc" }] },
      advanceAdjustments: { include: { advanceReceive: true } },
      oldGolds: { include: { purchase: true } },
    },
  });

export const buildSaleInvoicePdf = async (sale) => {
  const brand = buildBrand(sale.store || {});
  const cancelled = String(sale.status || "").toUpperCase() === "CANCELLED";
  const storeGstin = upper(sale.storeGst) || brand.gstin;
  const storePan = brand.pan || (storeGstin.length === 15 ? storeGstin.slice(2, 12) : "");
  const pdf = new BusinessDocument({
    brand,
    title: "TAX INVOICE",
    copyLabel: "Original for Recipient",
    identifiers: [["GSTIN", storeGstin || "-"], ["PAN", storePan || "-"], ["CIN", upper(sale.cinNo) || brand.cin || "-"]],
    reference: clean(sale.invoiceNo),
    cancelled,
    footerNote: brand.tagline ? `${brand.tagline}  ·  This is a computer-generated invoice.` : "This is a computer-generated invoice.",
  });
  const R = pdf.rupee;

  // ------------------------------------------------------------ cancelled banner
  if (cancelled) {
    const reason = clean(sale.cancelledReason);
    const text = `CANCELLED${sale.cancelledAt ? ` on ${istDateTime(sale.cancelledAt)}` : ""}${reason ? `  —  Reason: ${reason}` : ""}`;
    pdf.box(pdf.x, pdf.y, pdf.width, 20, { fill: COLORS.redTint, stroke: COLORS.red, radius: 3 });
    pdf.write(text, pdf.x + 10, pdf.y + 6, { width: pdf.width - 20, kind: "bold", size: 8.4, color: COLORS.red, spacing: 0.3 });
    pdf.y += 28;
  }

  // ------------------------------------------------------------ party / invoice panels
  const customer = sale.customer || {};
  const party = sale.party || {};
  const storeState = brand.state;
  const placeOfSupply = upper(sale.placeOfSupply) || upper(sale.customerState) || upper(customer.state) || storeState;
  const igstAmount = pick(sale.igstAmount, sale.igst);
  const cgstAmount = pick(sale.cgstAmount, sale.cgst);
  const sgstAmount = pick(sale.sgstAmount, sale.sgst);
  const gstType = upper(sale.gstType) || (igstAmount > 0 ? "INTER" : "INTRA");

  const leftW = 300;
  const gap = 12;
  const rightW = pdf.width - leftW - gap;
  const panelTop = pdf.y;
  const billTo = [
    ["Name", upper(party.name) || upper(sale.customerName) || upper(customer.name) || "-", { kind: "bold" }],
    ["Address", clean(sale.customerAddress) || clean(party.address) || clean(customer.address) || "-", { wrap: true }],
    ["City", clean(sale.customerCity) || clean(customer.city) || "-"],
    ["Phone", clean(sale.customerPhone) || clean(party.phone) || clean(customer.phone) || "-"],
    ["GSTIN", upper(sale.customerGst) || upper(party.gst) || upper(customer.gst) || "-"],
    ["PAN", upper(sale.customerPan) || upper(customer.pan) || "-"],
    ["State", stateWithCode(sale.customerState || customer.state || placeOfSupply)],
  ];
  if (clean(customer.customerCode)) billTo.push(["Customer ID", clean(customer.customerCode)]);
  const details = [
    ["Invoice No.", dash(sale.invoiceNo), { kind: "bold" }],
    ["Invoice Date", istDate(sale.saleDate)],
    ["Time", hasTime(sale.saleDate) ? istTime(sale.saleDate) : "-"],
    ["Place of Supply", stateWithCode(placeOfSupply)],
    ["Supply Type", gstType === "INTER" ? "Inter-state (IGST)" : "Intra-state (CGST + SGST)"],
    ["Cashier", dash(sale.cashierName)],
    ["Status", cancelled ? "CANCELLED" : "Completed", cancelled ? { kind: "bold", color: COLORS.red } : {}],
  ];
  if (clean(sale.irnNo)) details.push(["IRN", clean(sale.irnNo)]);

  const measureKv = (pairs, width, labelWidth) =>
    pairs.reduce((h, [, v, o = {}]) => h + (o.wrap ? Math.max(11.5, pdf.heightOf(v, { width: width - labelWidth, size: 7.8, lineGap: 1 }) + 2.5) : 11.5), 0);
  const panelH = Math.max(measureKv(billTo, leftW - 20, 62), measureKv(details, rightW - 20, 76)) + 24;
  pdf.box(pdf.x, panelTop, leftW, panelH);
  pdf.box(pdf.x + leftW + gap, panelTop, rightW, panelH);
  pdf.sectionLabel("Billed To", pdf.x + 10, panelTop + 8);
  pdf.sectionLabel("Invoice Details", pdf.x + leftW + gap + 10, panelTop + 8);
  pdf.keyValues(billTo, pdf.x + 10, panelTop + 20, { width: leftW - 20, labelWidth: 62 });
  pdf.keyValues(details, pdf.x + leftW + gap + 10, panelTop + 20, { width: rightW - 20, labelWidth: 76 });
  pdf.y = panelTop + panelH + 12;

  // ------------------------------------------------------------ item table
  const items = sale.items || [];
  const lines = items.map((item, index) => {
    const inv = item.inventory || {};
    const particulars = clean(item.particulars);
    const name =
      (particulars && !LEGACY_PARTICULARS.test(particulars) ? particulars : "") ||
      clean(inv.item?.name) ||
      clean(inv.product?.name) ||
      particulars ||
      "-";
    const code = clean(item.itemCode) || clean(inv.barcodeNo) || clean(inv.tagNo) || clean(inv.inventoryCode);
    const huid = clean(item.huidNo) || clean(inv.huidNo);
    const metal = clean(inv.metal?.name);
    const subParts = [code, huid ? `HUID ${huid}` : "", metal && !name.toUpperCase().includes(metal.toUpperCase()) ? metal : ""].filter(Boolean);
    const amount = num(item.taxableAmount) > 0 ? num(item.taxableAmount) : num(item.totalAmount);
    const hallmark = num(item.hallmarkCharges);
    const other = num(item.otherCharges) || num(item.otherAmount);
    const otherTotal = hallmark + other + num(item.wastageAmount);
    return {
      raw: { item, amount, otherTotal, hsn: clean(item.hsnCode) || clean(inv.hsnCode) || "-" },
      sr: String(index + 1),
      desc: { text: name.toUpperCase(), sub: subParts.join("  ·  "), kind: "bold" },
      hsn: clean(item.hsnCode) || clean(inv.hsnCode) || "-",
      purity: purityLabel(item, inv),
      pcs: String(num(item.pieces) || 1),
      gross: weight(item.grossWeight),
      stoneWt: weight(item.stoneWeight),
      net: weight(item.netWeight),
      rate: num(item.rate) > 0 ? rateText(item.rate) : "-",
      making: { text: inr(item.makingCharges), sub: makingSub(item, R) },
      stone: num(item.stoneAmount) > 0 ? inr(item.stoneAmount) : "-",
      other: { text: otherTotal > 0 ? inr(otherTotal) : "-", sub: hallmark > 0 ? `incl. HM ${inr(hallmark)}` : "" },
      disc: num(item.discount) > 0 ? `-${inr(item.discount)}` : "-",
      amount: { text: inr(amount), kind: "bold" },
    };
  });
  const hasDiscount = items.some((i) => num(i.discount) > 0);
  const columns = [
    { key: "sr", label: "#", width: 16, align: "center" },
    { key: "desc", label: "Description of Goods", width: hasDiscount ? 70 : 104, wrap: true },
    { key: "hsn", label: "HSN", width: 34, align: "center" },
    { key: "purity", label: "Purity", width: 34, align: "center" },
    { key: "pcs", label: "Pcs", width: 18, align: "center" },
    { key: "gross", label: "Gross Wt\n(g)", width: 38, align: "right" },
    { key: "stoneWt", label: "Stone Wt\n(g)", width: 34, align: "right" },
    { key: "net", label: "Net Wt\n(g)", width: 38, align: "right" },
    { key: "rate", label: `Rate\n(${R}/g)`, width: 40, align: "right" },
    { key: "making", label: "Making", width: 46, align: "right" },
    { key: "stone", label: "Stone", width: 36, align: "right" },
    { key: "other", label: "Hallmark\n/ Other", width: 38, align: "right" },
  ];
  if (hasDiscount) columns.push({ key: "disc", label: "Disc.", width: 34, align: "right" });
  columns.push({ key: "amount", label: `Amount\n(${R})`, width: pdf.width - columns.reduce((s, c) => s + c.width, 0), align: "right" });

  const sum = (fn) => items.reduce((s, it) => s + num(fn(it)), 0);
  const lineTotal = lines.reduce((s, l) => s + l.raw.amount, 0);
  const totals = {
    desc: `Total (${items.length} item${items.length === 1 ? "" : "s"})`,
    pcs: String(sum((i) => i.pieces || 1)),
    gross: weight(sum((i) => i.grossWeight)),
    stoneWt: weight(sum((i) => i.stoneWeight)),
    net: weight(sum((i) => i.netWeight)),
    making: inr(sum((i) => i.makingCharges)),
    stone: sum((i) => i.stoneAmount) > 0 ? inr(sum((i) => i.stoneAmount)) : "-",
    other: lines.some((l) => l.raw.otherTotal > 0) ? inr(lines.reduce((s, l) => s + l.raw.otherTotal, 0)) : "-",
    disc: hasDiscount ? `-${inr(sum((i) => i.discount))}` : undefined,
    amount: inr(lineTotal),
  };
  pdf.table(columns, lines.length ? lines : [{ desc: { text: "No items", kind: "italic" } }], { rowHeight: (row) => (row.desc?.text && pdf.lineCount(row.desc.text, columns[1].width - 6, { kind: "bold", size: 7.6 }) > 1 ? 31 : 23), totals });
  pdf.y += 12;

  // ------------------------------------------------------------ amounts (from stored values)
  const grossAmount = num(sale.grossAmount) > 0 ? num(sale.grossAmount) : lineTotal;
  const offerDiscount = num(sale.offerDiscount);
  const discount = num(sale.discount);
  const taxable = num(sale.taxableAmount) > 0 ? num(sale.taxableAmount) : Math.max(0, grossAmount - offerDiscount - discount);
  const totalTax = pick(sale.totalTax, sale.taxAmount) || cgstAmount + sgstAmount + igstAmount;
  const subTotal = pick(sale.subTotal, sale.subtotal) || taxable + totalTax;
  const advance = num(sale.advanceAmount);
  const oldGold = num(sale.oldGoldAmount);
  const lessUrd = num(sale.lessUrd);
  const roundOff = num(sale.roundOff);
  const netPayable = num(sale.netPayable);
  const paid = num(sale.paidAmount ?? 0);
  const due = sale.dueAmount !== null && sale.dueAmount !== undefined ? num(sale.dueAmount) : Math.max(0, netPayable - paid);

  const totalLines = [{ label: "Gross Amount", value: inr(grossAmount) }];
  if (offerDiscount) totalLines.push({ label: "Less: Offer Discount", value: `-${inr(offerDiscount)}` });
  if (discount) totalLines.push({ label: "Less: Discount", value: `-${inr(discount)}` });
  totalLines.push({ label: "Taxable Value", value: inr(taxable), kind: "strong" });
  if (cgstAmount) totalLines.push({ label: `CGST @ ${rateText(sale.cgstPercent)}%`, value: inr(cgstAmount) });
  if (sgstAmount) totalLines.push({ label: `SGST @ ${rateText(sale.sgstPercent)}%`, value: inr(sgstAmount) });
  if (igstAmount) totalLines.push({ label: `IGST @ ${rateText(sale.igstPercent)}%`, value: inr(igstAmount) });
  if (!cgstAmount && !sgstAmount && !igstAmount) totalLines.push({ label: "GST", value: "Nil", kind: "muted" });
  totalLines.push({ kind: "rule" }, { label: "Invoice Value", value: inr(subTotal), kind: "strong" });
  for (const adj of sale.advanceAdjustments || []) {
    const ref = adj.advanceReceive?.receiveDate ? ` (${istDate(adj.advanceReceive.receiveDate)})` : "";
    totalLines.push({ label: `Less: Advance #${adj.advanceReceiveId}${ref}`, value: `-${inr(adj.adjustedAmount || adj.amount)}`, color: COLORS.green });
  }
  if (!(sale.advanceAdjustments || []).length && advance) totalLines.push({ label: "Less: Advance Adjusted", value: `-${inr(advance)}`, color: COLORS.green });
  for (const og of sale.oldGolds || []) {
    const ref = clean(og.purchase?.invoiceNo);
    totalLines.push({ label: `Less: Old Gold${ref ? ` ${ref}` : ""}`, value: `-${inr(og.adjustedAmount || og.value)}`, color: COLORS.goldDark });
  }
  if (!(sale.oldGolds || []).length && oldGold) totalLines.push({ label: "Less: Old Gold Exchange", value: `-${inr(oldGold)}`, color: COLORS.goldDark });
  if (lessUrd) totalLines.push({ label: "Less: URD Purchase", value: `-${inr(lessUrd)}`, color: COLORS.goldDark });
  totalLines.push({ label: "Round Off", value: `${roundOff > 0 ? "+" : ""}${inr(roundOff)}`, kind: "muted" });
  totalLines.push({ label: "NET PAYABLE", value: `${R} ${inr(netPayable)}`, kind: "grand" });
  totalLines.push({ label: "Amount Paid", value: inr(paid), kind: "strong", color: COLORS.green });
  if (cancelled) totalLines.push({ label: "Balance Due", value: "Nil (cancelled)", kind: "due", color: COLORS.red });
  else totalLines.push({ label: "Balance Due", value: inr(due), kind: "due", color: due > 0.004 ? COLORS.red : COLORS.ink });

  // HSN summary
  const hsn = buildHsnSummary(
    lines.map((l) => ({ hsn: l.raw.hsn, amount: l.raw.amount, cgst: l.raw.item.cgst, sgst: l.raw.item.sgst, igst: l.raw.item.igst })),
    { taxable, cgst: cgstAmount, sgst: sgstAmount, igst: igstAmount, cgstRate: sale.cgstPercent, sgstRate: sale.sgstPercent, igstRate: sale.igstPercent }
  );
  const hsnSpec = hsnTableSpec(hsn, leftW);
  const noTax = !cgstAmount && !sgstAmount && !igstAmount;

  // payments
  const payments = sale.payments || [];
  const payColumns = [
    { key: "mode", label: "Mode", width: 62 },
    { key: "details", label: "Details", width: leftW - 62 - 74 },
    { key: "amount", label: `Amount (${R})`, width: 74, align: "right" },
  ];
  const payRows = payments.map((p) => ({
    mode: titleCase(p.paymentMode) === "Upi" ? "UPI" : titleCase(p.paymentMode),
    details: paymentDetails(p, sale.saleDate),
    amount: inr(p.amount),
  }));
  const words = numberToWordsIndian(netPayable);

  const hsnH = 12 + (noTax ? 26 : miniTableHeight(hsnSpec.rows.length, { totals: Boolean(hsnSpec.totals) }));
  const wordsH = wordsBoxHeight(pdf, words, leftW);
  const payH = 12 + (payRows.length ? miniTableHeight(payRows.length, { totals: payRows.length > 1 }) : 30);
  const leftH = hsnH + 10 + wordsH + 10 + payH;
  const rightH = totalsHeight(totalLines);
  pdf.ensure(Math.max(leftH, rightH) + 4);

  const top = pdf.y;
  const rx = pdf.x + leftW + gap;
  totalsBox(pdf, rx, top, rightW, totalLines);

  let ly = top;
  pdf.sectionLabel("HSN-wise Tax Summary", pdf.x, ly);
  ly += 12;
  if (noTax) {
    pdf.box(pdf.x, ly, leftW, 22, { fill: COLORS.panel });
    pdf.write("No GST charged on this invoice.", pdf.x + 8, ly + 7, { width: leftW - 16, kind: "italic", size: 7.6, color: COLORS.muted });
    ly += 26;
  } else {
    ly += miniTable(pdf, pdf.x, ly, hsnSpec.columns, hsnSpec.rows, { totals: hsnSpec.totals });
  }
  ly += 10;
  ly += wordsBox(pdf, pdf.x, ly, leftW, "Net payable (in words)", words);
  ly += 10;
  pdf.sectionLabel("Payment Details", pdf.x, ly);
  ly += 12;
  if (payRows.length) {
    ly += miniTable(pdf, pdf.x, ly, payColumns, payRows, { totals: payRows.length > 1 ? { mode: "Total", amount: inr(payments.reduce((s, p) => s + num(p.amount), 0)) } : null });
  } else {
    const settled = due <= 0.004;
    const [title, note, style, color] = cancelled
      ? ["Invoice cancelled", "No amount is due on a cancelled invoice.", { fill: COLORS.panel }, COLORS.red]
      : settled
        ? ["Settled through adjustments", "No counter payment was needed; see the adjustments in the totals.", { fill: COLORS.panel }, COLORS.navy]
        : ["Unpaid / Credit", `No payment received against this invoice. Balance due ${R} ${inr(due)}.`, { fill: COLORS.redTint, stroke: "#f3c7c1" }, COLORS.red];
    pdf.box(pdf.x, ly, leftW, 26, style);
    pdf.write(title, pdf.x + 8, ly + 5, { width: leftW - 16, kind: "bold", size: 8, color });
    pdf.write(note, pdf.x + 8, ly + 15, { width: leftW - 16, size: 7, color: COLORS.muted });
    ly += 30;
  }
  pdf.y = Math.max(ly, top + rightH) + 12;

  // ------------------------------------------------------------ narration, terms, signatures
  if (clean(sale.narration)) {
    const h = pdf.heightOf(clean(sale.narration), { width: pdf.width - 70, size: 7.6 });
    pdf.ensure(h + 6);
    pdf.write("Narration", pdf.x, pdf.y, { width: 60, kind: "bold", size: 7.6, color: COLORS.muted });
    pdf.paragraph(clean(sale.narration), pdf.x + 62, pdf.y, { width: pdf.width - 62, size: 7.6 });
    pdf.y += h + 8;
  }

  const terms = brand.terms.length
    ? brand.terms
    : [
        "Weight, purity and pieces were verified by the customer at the time of delivery.",
        "Hallmarked jewellery carries the BIS HUID shown against each item.",
        "Please retain this invoice for exchange, buy-back or warranty claims.",
      ];
  if (brand.city) terms.push(`Subject to ${brand.city} jurisdiction.`);
  const declaration =
    "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.";
  const termsText = terms.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const colW = (pdf.width - gap) / 2;
  const termsH = Math.max(pdf.heightOf(termsText, { width: colW, size: 6.9, lineGap: 1.2 }), pdf.heightOf(declaration, { width: colW, size: 6.9, lineGap: 1.2 })) + 14;
  pdf.ensure(termsH + 56);
  pdf.hline(pdf.x, pdf.right, pdf.y, { color: COLORS.line });
  pdf.y += 7;
  pdf.sectionLabel("Terms & Conditions", pdf.x, pdf.y);
  pdf.sectionLabel("Declaration", pdf.x + colW + gap, pdf.y);
  pdf.paragraph(termsText, pdf.x, pdf.y + 11, { width: colW, size: 6.9, color: COLORS.muted, lineGap: 1.2 });
  pdf.paragraph(declaration, pdf.x + colW + gap, pdf.y + 11, { width: colW, size: 6.9, color: COLORS.muted, lineGap: 1.2 });
  pdf.y += termsH + 4;
  pdf.signatureBlocks([
    { label: "Customer's Signature", caption: "Received the goods in good condition" },
    { label: "Authorised Signatory", caption: `For ${brand.name.toUpperCase()}` },
  ]);

  return pdf.toBuffer();
};

export const generateSalePdf = async (id, storeId, res) => {
  const sale = await loadSale(id, storeId);
  if (!sale) throw new AppError("Sale invoice not found for this store", 404);
  const buffer = await buildSaleInvoicePdf(sale);
  sendPdf(res, buffer, `Invoice-${sale.invoiceNo || sale.id}.pdf`);
};
