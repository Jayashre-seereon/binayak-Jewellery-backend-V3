import prisma from "../config/db.js";
import { numberToWordsIndian } from "../utils/numberToWords.js";
import { AppError } from "../utils/validate.js";
import { publicStoreSelect } from "../utils/publicSelect.js";
import { buildBrand } from "./documents/brand.js";
import { BusinessDocument, COLORS, sendPdf } from "./documents/engine.js";
import { buildHsnSummary, hsnTableSpec, miniTable, miniTableHeight, totalsBox, totalsHeight, wordsBox, wordsBoxHeight } from "./documents/blocks.js";
import { clean, dash, inr, istDate, istDateTime, maskId, num, panFromGstin, rateText, stateWithCode, titleCase, upper, weight } from "./documents/format.js";

const purityLabel = (item) => {
  const name = clean(item.purityMaster?.name) || (num(item.purity) > 0 ? String(item.purity) : "");
  return name ? name.replace(/\s*carats?$/i, "K").replace(/^(\d+)\s+K$/i, "$1K") : "-";
};

const paymentDetails = (p) => {
  const parts = [];
  const channel = clean(p.paymentChannel);
  if (channel && channel.toUpperCase() !== String(p.paymentMode || "").toUpperCase()) parts.push(channel);
  const txn = clean(p.transactionId);
  const ref = clean(p.referenceNo);
  if (txn) parts.push(`Txn ${txn}`);
  if (ref && ref !== txn) parts.push(`Ref ${ref}`);
  const note = clean(p.description) || clean(p.narration);
  if (note) parts.push(note);
  if (p.paymentDate) parts.push(istDate(p.paymentDate));
  return parts.join(" · ") || "-";
};

const loadPurchase = (id, storeId) =>
  prisma.purchase.findFirst({
    where: { id: Number(id), storeId: Number(storeId) },
    include: {
      store: { select: publicStoreSelect },
      party: true,
      customer: true,
      employee: { select: { id: true, name: true } },
      payments: { orderBy: [{ paymentDate: "asc" }, { id: "asc" }] },
      items: {
        orderBy: { id: "asc" },
        include: { item: true, product: true, metal: true, purityMaster: true, stone: true },
      },
    },
  });

export const buildPurchasePdf = async (purchase) => {
  const brand = buildBrand(purchase.store || {});
  const isOld = upper(purchase.purchaseType) === "OLD";
  const pdf = new BusinessDocument({
    brand,
    title: isOld ? "PURCHASE VOUCHER" : "PURCHASE INVOICE",
    copyLabel: isOld ? "Old Gold / URD Purchase" : "Inward Supply Record",
    identifiers: [["GSTIN", brand.gstin || "-"], ["PAN", brand.pan || "-"], ["CIN", brand.cin || "-"]],
    reference: clean(purchase.invoiceNo) || `#${purchase.id}`,
    footerNote: "This is a computer-generated purchase document.",
  });
  const R = pdf.rupee;

  // ------------------------------------------------------------ panels
  const party = purchase.party || {};
  const customer = purchase.customer || {};
  const partyGstin = upper(party.gst);
  const igst = num(purchase.igst);
  const cgst = num(purchase.cgst);
  const sgst = num(purchase.sgst);
  const storedTax = num(purchase.taxAmount ?? 0) || cgst + sgst + igst;
  const isRcm = Boolean(purchase.isRCM);
  const placeOfSupply = upper(purchase.placeOfSupply) || upper(customer.state) || brand.state;
  const taxMode = isRcm
    ? "Reverse charge (RCM)"
    : storedTax <= 0
      ? "No GST charged"
      : igst > 0
        ? "Inter-state (IGST)"
        : "Intra-state (CGST + SGST)";

  const leftW = 300;
  const gap = 12;
  const rightW = pdf.width - leftW - gap;
  const idProof = [clean(purchase.customerIdType), maskId(purchase.customerIdNumber)].filter(Boolean).join(" ");
  const from = [
    ["Name", upper(party.name) || upper(purchase.customerName) || upper(customer.name) || "-", { kind: "bold" }],
    ["Address", clean(party.address) || clean(purchase.address) || clean(customer.address) || "-", { wrap: true }],
    ["Phone", clean(party.phone) || clean(purchase.customerPhone) || clean(customer.phone) || "-"],
  ];
  if (purchase.partyId) {
    from.push(["GSTIN", partyGstin || "-"], ["PAN", panFromGstin(partyGstin) || "-"]);
  } else {
    from.push(["ID Proof", idProof || "-"], ["PAN", upper(customer.pan) || "-"]);
  }
  from.push(["State", stateWithCode(placeOfSupply)]);

  const details = [
    [isOld ? "Voucher No." : "Purchase No.", dash(purchase.invoiceNo), { kind: "bold" }],
    ["Date", istDateTime(purchase.date)],
  ];
  if (!isOld || clean(purchase.referenceNo)) details.push(["Supplier Bill No.", dash(purchase.referenceNo)]);
  if (purchase.referenceDate) details.push(["Supplier Bill Date", istDate(purchase.referenceDate)]);
  details.push(["Purchase Type", titleCase(purchase.purchaseType) + (isOld ? " (URD)" : "")]);
  details.push(["Place of Supply", stateWithCode(placeOfSupply)]);
  details.push(["Tax", taxMode]);
  details.push(["Staff", dash(purchase.employee?.name)]);

  const measureKv = (pairs, width, labelWidth) =>
    pairs.reduce((h, [, v, o = {}]) => h + (o.wrap ? Math.max(11.5, pdf.heightOf(v, { width: width - labelWidth, size: 7.8, lineGap: 1 }) + 2.5) : 11.5), 0);
  const panelTop = pdf.y;
  const panelH = Math.max(measureKv(from, leftW - 20, 62), measureKv(details, rightW - 20, 82)) + 24;
  pdf.box(pdf.x, panelTop, leftW, panelH);
  pdf.box(pdf.x + leftW + gap, panelTop, rightW, panelH);
  pdf.sectionLabel(isOld ? "Purchased From (Seller)" : "Supplier", pdf.x + 10, panelTop + 8);
  pdf.sectionLabel(isOld ? "Voucher Details" : "Purchase Details", pdf.x + leftW + gap + 10, panelTop + 8);
  pdf.keyValues(from, pdf.x + 10, panelTop + 20, { width: leftW - 20, labelWidth: 62 });
  pdf.keyValues(details, pdf.x + leftW + gap + 10, panelTop + 20, { width: rightW - 20, labelWidth: 82 });
  pdf.y = panelTop + panelH + 12;

  // ------------------------------------------------------------ items
  const items = purchase.items || [];
  const showFine = items.some((i) => num(i.pureWeight) > 0);
  const lines = items.map((item, index) => {
    const metal = clean(item.metal?.name);
    const name = clean(item.item?.name) || clean(item.product?.name) || (metal ? (isOld ? `Old ${metal} ornaments` : metal) : "-");
    const sub = [clean(item.purchaseItemCode), clean(item.tagNo), clean(item.huidNo) ? `HUID ${clean(item.huidNo)}` : "", clean(item.stone?.name)]
      .filter(Boolean)
      .join("  ·  ");
    const lessWt = num(item.stoneWeight) + num(item.dustWeight) + num(item.deductionWeight);
    const extras = num(item.makingCharges) + num(item.hallmarkCharges) + num(item.otherAmount) + num(item.stoneAmount);
    const extraSub = [
      num(item.makingCharges) ? `MC ${inr(item.makingCharges)}` : "",
      num(item.stoneAmount) ? `Stone ${inr(item.stoneAmount)}` : "",
      num(item.hallmarkCharges) ? `HM ${inr(item.hallmarkCharges)}` : "",
    ].filter(Boolean);
    const touch = num(item.touchPercentage) || num(item.fineness);
    return {
      raw: { item, amount: num(item.totalAmount), extras, lessWt, hsn: clean(item.hsnCode) || "-" },
      sr: String(index + 1),
      desc: { text: name.toUpperCase(), sub, kind: "bold" },
      hsn: clean(item.hsnCode) || "-",
      purity: { text: purityLabel(item), sub: touch ? `Touch ${rateText(touch)}%` : "" },
      pcs: String(num(item.pieces) || 1),
      gross: weight(item.grossWeight),
      less: lessWt > 0 ? weight(lessWt) : "-",
      net: weight(item.netWeight),
      fine: num(item.pureWeight) > 0 ? weight(item.pureWeight) : "-",
      rate: num(item.rate) > 0 ? rateText(item.rate) : "-",
      metal: num(item.metalAmount) > 0 ? inr(item.metalAmount) : "-",
      extras: { text: extras > 0 ? inr(extras) : "-", sub: extraSub.length > 1 ? extraSub.join(" + ") : extraSub[0] && !extraSub[0].startsWith("MC") ? extraSub[0] : "" },
      disc: num(item.discount) > 0 ? `-${inr(item.discount)}` : "-",
      amount: { text: inr(item.totalAmount), kind: "bold" },
    };
  });
  const hasDiscount = items.some((i) => num(i.discount) > 0);
  let descW = 112;
  if (showFine) descW -= 36;
  if (hasDiscount) descW -= 34;
  const columns = [
    { key: "sr", label: "#", width: 16, align: "center" },
    { key: "desc", label: "Description", width: descW, wrap: true },
    { key: "hsn", label: "HSN", width: 34, align: "center" },
    { key: "purity", label: "Purity", width: 40, align: "center" },
    { key: "pcs", label: "Pcs", width: 18, align: "center" },
    { key: "gross", label: "Gross Wt\n(g)", width: 38, align: "right" },
    { key: "less", label: "Less Wt\n(g)", width: 34, align: "right" },
    { key: "net", label: "Net Wt\n(g)", width: 38, align: "right" },
  ];
  if (showFine) columns.push({ key: "fine", label: "Fine Wt\n(g)", width: 36, align: "right" });
  columns.push(
    { key: "rate", label: `Rate\n(${R}/g)`, width: 40, align: "right" },
    { key: "metal", label: "Metal\nValue", width: 50, align: "right" },
    { key: "extras", label: "Making /\nOther", width: 48, align: "right" }
  );
  if (hasDiscount) columns.push({ key: "disc", label: "Disc.", width: 34, align: "right" });
  columns.push({ key: "amount", label: `Amount\n(${R})`, width: pdf.width - columns.reduce((s, c) => s + c.width, 0), align: "right" });

  const sum = (fn) => items.reduce((s, it) => s + num(fn(it)), 0);
  const lineTotal = sum((i) => i.totalAmount);
  const totals = {
    desc: `Total (${items.length} item${items.length === 1 ? "" : "s"})`,
    pcs: String(sum((i) => i.pieces || 1)),
    gross: weight(sum((i) => i.grossWeight)),
    less: lines.some((l) => l.raw.lessWt > 0) ? weight(lines.reduce((s, l) => s + l.raw.lessWt, 0)) : "-",
    net: weight(sum((i) => i.netWeight)),
    fine: showFine ? weight(sum((i) => i.pureWeight)) : undefined,
    metal: sum((i) => i.metalAmount) > 0 ? inr(sum((i) => i.metalAmount)) : "-",
    extras: lines.some((l) => l.raw.extras > 0) ? inr(lines.reduce((s, l) => s + l.raw.extras, 0)) : "-",
    disc: hasDiscount ? `-${inr(sum((i) => i.discount))}` : undefined,
    amount: inr(lineTotal),
  };
  pdf.table(columns, lines.length ? lines : [{ desc: { text: "No items", kind: "italic" } }], { rowHeight: (row) => (row.desc?.text && pdf.lineCount(row.desc.text, columns[1].width - 6, { kind: "bold", size: 7.6 }) > 1 ? 31 : 23), totals });
  pdf.y += 12;

  // ------------------------------------------------------------ amounts: stored values only (never recomputed tax)
  const grossAmount = num(purchase.grossAmount) > 0 ? num(purchase.grossAmount) : lineTotal;
  const discount = num(purchase.discount);
  const taxable = num(purchase.taxableAmount) > 0 ? num(purchase.taxableAmount) : Math.max(0, grossAmount - discount);
  const showTax = !isRcm && storedTax > 0;
  // `subtotal` is not used consistently by the purchase module, so the invoice value is taxable + stored tax.
  const subTotal = taxable + (showTax ? storedTax : 0);
  const roundOff = num(purchase.roundOff);
  const netPayable = purchase.netPayable !== null && purchase.netPayable !== undefined && num(purchase.netPayable) > 0 ? num(purchase.netPayable) : num(purchase.totalAmount);
  const paid = num(purchase.paidAmount ?? 0);
  const due = purchase.dueAmount !== null && purchase.dueAmount !== undefined ? num(purchase.dueAmount) : Math.max(0, netPayable - paid);
  const adjusted = num(purchase.adjustedAmount);

  const totalLines = [{ label: "Gross Amount", value: inr(grossAmount) }];
  if (discount) totalLines.push({ label: "Less: Discount", value: `-${inr(discount)}` });
  totalLines.push({ label: "Taxable Value", value: inr(taxable), kind: "strong" });
  if (showTax) {
    const rateOf = (amount) => (taxable > 0 ? ` @ ${rateText(Math.round((amount / taxable) * 10000) / 100)}%` : "");
    if (cgst) totalLines.push({ label: `CGST${rateOf(cgst)}`, value: inr(cgst) });
    if (sgst) totalLines.push({ label: `SGST${rateOf(sgst)}`, value: inr(sgst) });
    if (igst) totalLines.push({ label: `IGST${rateOf(igst)}`, value: inr(igst) });
    totalLines.push({ kind: "rule" }, { label: "Invoice Value", value: inr(subTotal), kind: "strong" });
  } else {
    totalLines.push({ label: isRcm ? "GST (reverse charge)" : "GST", value: isRcm ? "Payable by recipient" : "Nil", kind: "muted" });
  }
  if (roundOff) totalLines.push({ label: "Round Off", value: `${roundOff > 0 ? "+" : ""}${inr(roundOff)}`, kind: "muted" });
  totalLines.push({ label: isOld ? "NET VALUE" : "NET PAYABLE", value: `${R} ${inr(netPayable)}`, kind: "grand" });
  totalLines.push({ label: "Amount Paid", value: inr(paid), kind: "strong", color: COLORS.green });
  if (isOld && adjusted > 0) totalLines.push({ label: "Adjusted against sales", value: inr(adjusted), color: COLORS.goldDark });
  totalLines.push({ label: "Balance Due", value: inr(due), kind: "due", color: due > 0.004 ? COLORS.red : COLORS.ink });

  const hsn = buildHsnSummary(
    lines.map((l) => ({ hsn: l.raw.hsn, amount: l.raw.amount })),
    { taxable, cgst: showTax ? cgst : 0, sgst: showTax ? sgst : 0, igst: showTax ? igst : 0, cgstRate: taxable ? Math.round((cgst / taxable) * 10000) / 100 : 0, sgstRate: taxable ? Math.round((sgst / taxable) * 10000) / 100 : 0, igstRate: taxable ? Math.round((igst / taxable) * 10000) / 100 : 0 }
  );
  const hsnSpec = hsnTableSpec(hsn, leftW);

  const payments = purchase.payments || [];
  const payColumns = [
    { key: "mode", label: "Mode", width: 62 },
    { key: "details", label: "Details", width: leftW - 62 - 74 },
    { key: "amount", label: `Amount (${R})`, width: 74, align: "right" },
  ];
  const payRows = payments.map((p) => ({ mode: titleCase(p.paymentMode) === "Upi" ? "UPI" : titleCase(p.paymentMode) || "-", details: paymentDetails(p), amount: inr(p.amount) }));
  const words = numberToWordsIndian(netPayable);

  const taxNote = isRcm ? "Tax on this supply is payable under reverse charge." : "No GST charged on this purchase.";
  const hsnH = 12 + (showTax ? miniTableHeight(hsnSpec.rows.length, { totals: Boolean(hsnSpec.totals) }) : 26);
  const wordsH = wordsBoxHeight(pdf, words, leftW);
  const payH = 12 + (payRows.length ? miniTableHeight(payRows.length, { totals: payRows.length > 1 }) : 30);
  pdf.ensure(Math.max(hsnH + wordsH + payH + 20, totalsHeight(totalLines)) + 4);

  const top = pdf.y;
  const rightH = totalsBox(pdf, pdf.x + leftW + gap, top, rightW, totalLines);
  let ly = top;
  pdf.sectionLabel("HSN-wise Tax Summary", pdf.x, ly);
  ly += 12;
  if (showTax) {
    ly += miniTable(pdf, pdf.x, ly, hsnSpec.columns, hsnSpec.rows, { totals: hsnSpec.totals });
  } else {
    pdf.box(pdf.x, ly, leftW, 22, { fill: COLORS.panel });
    pdf.write(taxNote, pdf.x + 8, ly + 7, { width: leftW - 16, kind: "italic", size: 7.6, color: COLORS.muted });
    ly += 26;
  }
  ly += 10;
  ly += wordsBox(pdf, pdf.x, ly, leftW, isOld ? "Net value (in words)" : "Net payable (in words)", words);
  ly += 10;
  pdf.sectionLabel("Payment Details", pdf.x, ly);
  ly += 12;
  if (payRows.length) {
    ly += miniTable(pdf, pdf.x, ly, payColumns, payRows, { totals: payRows.length > 1 ? { mode: "Total", amount: inr(payments.reduce((s, p) => s + num(p.amount), 0)) } : null });
  } else {
    const exchange = isOld && num(purchase.balanceAmount) > 0;
    const settled = !exchange && due <= 0.004;
    const [title, note, fill, stroke, color] = exchange
      ? ["Not paid — held for exchange", `${R} ${inr(purchase.balanceAmount)} is available to adjust against a jewellery purchase.`, COLORS.goldTint, COLORS.line, COLORS.goldDark]
      : settled
        ? ["Settled", "No separate payment lines are recorded against this document.", COLORS.panel, COLORS.line, COLORS.navy]
        : ["Unpaid / Credit", `No payment has been recorded. Balance due ${R} ${inr(due)}.`, COLORS.redTint, "#f3c7c1", COLORS.red];
    pdf.box(pdf.x, ly, leftW, 26, { fill, stroke });
    pdf.write(title, pdf.x + 8, ly + 5, { width: leftW - 16, kind: "bold", size: 8, color });
    pdf.write(note, pdf.x + 8, ly + 15, { width: leftW - 16, size: 7, color: COLORS.muted });
    ly += 30;
  }
  pdf.y = Math.max(ly, top + rightH) + 12;

  if (clean(purchase.narration)) {
    const h = pdf.heightOf(clean(purchase.narration), { width: pdf.width - 62, size: 7.6 });
    pdf.ensure(h + 6);
    pdf.write("Narration", pdf.x, pdf.y, { width: 60, kind: "bold", size: 7.6, color: COLORS.muted });
    pdf.paragraph(clean(purchase.narration), pdf.x + 62, pdf.y, { width: pdf.width - 62, size: 7.6 });
    pdf.y += h + 8;
  }

  const declaration = isOld
    ? "I, the seller, declare that the ornaments / metal sold under this voucher are my own lawful property, free from any claim, and that the weight, purity and value stated above have been verified in my presence and accepted by me."
    : "Goods received as per the supplier's invoice referenced above. Weights and purity were checked on receipt; any discrepancy must be reported to the supplier in writing.";
  const h = pdf.heightOf(declaration, { width: pdf.width, size: 6.9, lineGap: 1.2 }) + 14;
  pdf.ensure(h + 56);
  pdf.hline(pdf.x, pdf.right, pdf.y, { color: COLORS.line });
  pdf.y += 7;
  pdf.sectionLabel("Declaration", pdf.x, pdf.y);
  pdf.paragraph(declaration, pdf.x, pdf.y + 11, { width: pdf.width, size: 6.9, color: COLORS.muted, lineGap: 1.2 });
  pdf.y += h + 4;
  pdf.signatureBlocks([
    { label: isOld ? "Seller's Signature" : "Received / Checked By", caption: isOld ? "Received the amount / exchange value" : "" },
    { label: "Authorised Signatory", caption: `For ${brand.name.toUpperCase()}` },
  ]);

  return pdf.toBuffer();
};

export const generatePurchasePdf = async (id, storeId, res) => {
  if (!Number(storeId)) throw new AppError("Please select a store before downloading the purchase.", 400);
  const purchase = await loadPurchase(id, storeId);
  if (!purchase) throw new AppError("Purchase not found for this store", 404);
  const buffer = await buildPurchasePdf(purchase);
  sendPdf(res, buffer, `Purchase-${purchase.invoiceNo || purchase.id}.pdf`);
};
