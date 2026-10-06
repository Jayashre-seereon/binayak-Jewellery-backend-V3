"""Generates legacy_data_corrections.sql: restores data the Phase-2 migration lost or mis-read.

Keyed by the legacy ids the Phase-2 migration preserved:
  Sale.id = RI_ID · Voucher.id = VHR_ID · Purchase.id = 800000 + OP_ID (old metal)
  Inventory.barcodeNo = BCM_BAR_CODE · AdvanceReceive matched by voucher number (AR_VRNO)
Idempotent: every statement can be re-run.
"""
import json, datetime, collections, re

DUMP = "/home/claude/work/dump"
OUT = "/home/claude/v3/migfix/legacy_data_corrections.sql"
T = lambda n: json.load(open(f"{DUMP}/{n}.json"))["rows"]
B = datetime.datetime(1900, 1, 1)
STORE = 1


def real_dt(s):
    """The MDF reader swapped the two 4-byte halves of SQL Server DATETIME (time ticks first,
    then days). Recover: days = misread seconds x 300, ticks = misread days."""
    if not s:
        return None
    dt = datetime.datetime.fromisoformat(s)
    d = dt - B
    secs = d.seconds + d.microseconds / 1e6
    days = round(secs * 300)
    if days <= 0:
        return None
    return B + datetime.timedelta(days=days, seconds=d.days / 300.0)


def q(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(round(v, 6)) if isinstance(v, float) else str(v)
    if isinstance(v, datetime.datetime):
        return "'" + v.strftime("%Y-%m-%d %H:%M:%S") + "'::timestamp"
    return "'" + str(v).replace("'", "''") + "'"


def clean(s):
    if s is None:
        return None
    s = re.sub(r"[\r\n]+", " ", str(s)).strip()
    return s or None


out = []
w = out.append


def values_update(table, keycol, cols, rows, casts, chunk=500, where_extra=""):
    if not rows:
        return
    for i in range(0, len(rows), chunk):
        part = rows[i:i + chunk]
        sets = ", ".join(f'"{c}" = v."{c}"{casts.get(c, "")}' for c in cols)
        names = ", ".join(f'"{c}"' for c in [keycol] + cols)
        vals = ",\n  ".join("(" + ", ".join(q(x) for x in r) + ")" for r in part)
        w(f'UPDATE "{table}" t SET {sets}\nFROM (VALUES\n  {vals}\n) AS v({names})\nWHERE t."{keycol}" = v."{keycol}"{where_extra};')


w("-- Binayak ERP v3.1 — legacy data corrections (generated from the original JMSysSplash data).")
w("-- 1) real dates for sales, payments, vouchers, ledger, old-metal purchases, advances and stock")
w("-- 2) real advance amounts + their sale adjustments  3) old-gold exchange links on sales")
w("-- 4) old-metal purchase settlement  5) counter location + reject reason per piece")
w("-- 6) the 3 barcodes the first migration skipped  7) whitespace clean-up of names/addresses")
w("BEGIN;")
w("")

# ---------------------------------------------------------------- 1. sales
inv = T("JSP_RTL_INVC")
sale_dates = {}
rows = []
for r in inv:
    d = real_dt(r["RI_DATE"])
    if d:
        sale_dates[r["RI_ID"]] = d
        rows.append((r["RI_ID"], d, d, clean(r["RI_CST_NAME"]), clean(r["RI_CST_ADDRESS"])))
w(f"-- Sales: {len(rows)} invoice dates")
values_update("Sale", "id", ["saleDate", "createdAt", "customerName", "customerAddress"], rows,
              {"saleDate": "::timestamp", "createdAt": "::timestamp"})
w('UPDATE "SalePayment" p SET "paymentDate" = s."saleDate", "createdAt" = s."saleDate" FROM "Sale" s WHERE p."saleId" = s.id AND p.id BETWEEN 6000000 AND 6999999;')
w('UPDATE "SaleItem" i SET "createdAt" = s."saleDate", "updatedAt" = s."saleDate" FROM "Sale" s WHERE i."saleId" = s.id AND i.id BETWEEN 7000000 AND 7999999;')
w("")

# ---------------------------------------------------------------- 2. vouchers + ledger
vh = T("ACN_VHR")
rows = [(r["VHR_ID"], real_dt(r["VHR_DATE"]), real_dt(r["VHR_DATE"])) for r in vh if real_dt(r["VHR_DATE"])]
w(f"-- Vouchers: {len(rows)} dates (ledger lines follow their voucher)")
values_update("Voucher", "id", ["date", "createdAt"], rows, {"date": "::timestamp", "createdAt": "::timestamp"},
              where_extra=" AND t.\"referenceType\" IN ('RetailInvoice','OldMetalPurchase','AdvanceReceive')")
w('UPDATE "LedgerEntry" e SET date = v.date, "createdAt" = v.date FROM "Voucher" v WHERE e."voucherId" = v.id AND e.id BETWEEN 5000000 AND 5999999;')
# link legacy sale vouchers to their sale
w("UPDATE \"Voucher\" v SET \"saleId\" = s.id, \"referenceDocNo\" = s.\"invoiceNo\" FROM \"Sale\" s "
  "WHERE v.\"referenceType\" = 'RetailInvoice' AND v.\"saleId\" IS NULL AND s.\"storeId\" = v.\"storeId\" "
  "AND s.\"invoiceNo\" = substring(v.narration from 'No\\.\\s*(\\S+)\\s*$');")
w("")

# ---------------------------------------------------------------- 3. old-metal purchases + exchange links
op = {r["OP_ID"]: r for r in T("JSP_OLD_PURCHASE")}
opd = collections.defaultdict(list)
for r in T("JSP_OLD_PURCHASE_DTL"):
    opd[r["OP_ID"]].append(r)
oa = T("JSP_OLD_ADJST")
adj = collections.defaultdict(float)
for r in oa:
    adj[r["OP_ID"]] += float(r["OA_AMT"] or 0)
rows = []
for oid, r in op.items():
    net = round(float(r["OP_TOTAL_AMT"] or 0), 2)
    a = round(adj[oid], 2)
    d = real_dt(r["OP_DATE"])
    if a >= net - 0.01:
        # fully exchanged against a sale in the legacy system
        rows.append((800000 + oid, d, d, a, 0.0, 0.0, 0.0, "FULLY_ADJUSTED", clean(r["OP_CST_NAME"]), clean(r["OP_CST_ADDRESS"]), None))
    else:
        # value held on the customer's credit in the legacy books (PMD credit) — still open
        open_amt = round(net - a, 2)
        rows.append((800000 + oid, d, d, a, 0.0, open_amt, open_amt, "AVAILABLE" if a < 0.01 else "PARTIALLY_ADJUSTED",
                     clean(r["OP_CST_NAME"]), clean(r["OP_CST_ADDRESS"]),
                     f"Migrated {r['OP_VRNO']}: old-gold value Rs {open_amt:,.2f} was left on customer credit in the old system - confirm before use."))
w(f"-- Old-metal purchases: {len(rows)} (date, settlement)")
values_update("Purchase", "id", ["date", "createdAt", "adjustedAmount", "paidAmount", "dueAmount", "balanceAmount",
                                 "adjustmentStatus", "customerName", "address", "narration"], rows,
              {"date": "::timestamp", "createdAt": "::timestamp", "adjustedAmount": "::double precision",
               "paidAmount": "::double precision", "dueAmount": "::double precision", "balanceAmount": "::double precision"})
w('UPDATE "PurchaseItem" i SET "createdAt" = p.date, "updatedAt" = p.date FROM "Purchase" p WHERE i."purchaseId" = p.id AND p.id BETWEEN 800001 AND 899999;')
# exchange rows on the sales
ins = []
for r in oa:
    p = op.get(r["OP_ID"])
    if not p:
        continue
    det = opd.get(r["OP_ID"], [{}])[0]
    ins.append((r["RI_ID"], 800000 + r["OP_ID"], f"Old gold {p['OP_VRNO']}", float(p["OP_GRS_WT"] or 0),
                float(p["OP_STN_WT"] or 0), float(p["OP_NET_WT"] or 0), float(det.get("OPD_PURT_PRCNT") or 0) or None,
                float(det.get("OPD_MTL_RATE") or 0), float(p["OP_MTL_AMT"] or 0), float(r["OA_AMT"] or 0),
                float(r["OA_AMT"] or 0), float(p["OP_TOTAL_AMT"] or 0)))
w(f"-- Old-gold exchange links on sales: {len(ins)}")
vals = ",\n  ".join("(" + ", ".join(q(x) for x in t) + ")" for t in ins)
w('INSERT INTO "SaleOldGold" ("saleId", "purchaseId", description, "grossWeight", "stoneWeight", "netWeight", purity, rate, "metalAmount", value, "adjustedAmount", "previousBalance", "remainingBalance", "storeId", "createdAt")')
w(f"SELECT v.sid, v.pid, v.descr, v.g, v.s, v.n, v.pur, v.rate, v.ma, v.val, v.adj, v.prev, GREATEST(v.prev - v.adj, 0), {STORE}, s.\"saleDate\"")
w(f"FROM (VALUES\n  {vals}\n) AS v(sid, pid, descr, g, s, n, pur, rate, ma, val, adj, prev)")
w('JOIN "Sale" s ON s.id = v.sid JOIN "Purchase" p ON p.id = v.pid')
w("ON CONFLICT (\"saleId\", \"purchaseId\") DO NOTHING;")
w('UPDATE "Purchase" p SET "customerPhone" = s."customerPhone", "customerId" = s."customerId" FROM "SaleOldGold" g JOIN "Sale" s ON s.id = g."saleId" '
  "WHERE g.\"purchaseId\" = p.id AND p.id BETWEEN 800001 AND 899999 AND p.\"customerPhone\" IS NULL AND s.\"customerPhone\" ~ '^[6-9][0-9]{9}$';")
w("")

# ---------------------------------------------------------------- 4. advances
ar = T("JSP_ADV_RCV")
avh = {r["VHR_REF_ID"]: r for r in vh if r["VHR_TYPE"] == "AdvanceReceive"}
vhd = collections.defaultdict(list)
for d in T("ACN_VHR_DTL"):
    vhd[d["VHR_ID"]].append(d)
used = collections.defaultdict(list)
for r in T("JSP_ADV_RCV_VHR_ADJST"):
    used[r["ADV_VHR_ID"]].append(r)
rows = []
links = []
for r in ar:
    v = avh.get(r["AR_ID"])
    amount = round(sum(float(x["LDR_DR_AMT"] or 0) for x in vhd.get(v["VHR_ID"], [])), 2) if v else 0.0
    d = real_dt(v["VHR_DATE"]) if v else None
    u = round(sum(float(x["ADV_AMT"] or 0) for x in used.get(r["AR_ID"], [])), 2)
    bal = round(max(amount - u, 0), 2)
    if bal <= 0.01:
        status = "FULLY_ADJUSTED"
    elif u > 0.01:
        status = "PARTIALLY_ADJUSTED"
    else:
        status = "AVAILABLE"
    spec = f"Migrated advance {r['AR_VRNO']}" + (f" (legacy voucher {v['VHR_NO']})" if v else "")
    rows.append((r["AR_VRNO"], amount, u, bal, status, d, d, spec, clean(r["AR_CST_NAME"]), clean(r["AR_CST_ADDRESS"])))
    for x in used.get(r["AR_ID"], []):
        links.append((x["RI_ID"], r["AR_VRNO"], float(x["ADV_AMT"] or 0), amount))
    if v:
        w(f"UPDATE \"Voucher\" SET \"advanceReceiveId\" = a.id, \"referenceDocNo\" = {q(r['AR_VRNO'])} FROM \"AdvanceReceive\" a "
          f"WHERE \"Voucher\".id = {v['VHR_ID']} AND a.\"storeId\" = {STORE} AND a.specification LIKE {q('%' + r['AR_VRNO'] + '%')};")
w(f"-- Advances: {len(rows)} real amounts recovered from their receipt vouchers")
vals = ",\n  ".join("(" + ", ".join(q(x) for x in t) + ")" for t in rows)
w('UPDATE "AdvanceReceive" a SET amount = v.amount::numeric(12,2), "adjustedAmount" = v.used, "balanceAmount" = v.bal, status = v.status, '
  '"receiveDate" = v.d1::timestamp, "createdAt" = v.d2::timestamp, specification = v.spec, "customerName" = COALESCE(v.nm, a."customerName"), address = v.addr')
w(f"FROM (VALUES\n  {vals}\n) AS v(vrno, amount, used, bal, status, d1, d2, spec, nm, addr)")
w(f"WHERE a.\"storeId\" = {STORE} AND (a.specification LIKE '%(voucher ' || v.vrno || ')%' OR a.specification LIKE 'Migrated advance ' || v.vrno || '%');")
w('UPDATE "AdvanceReceive" a SET "customerId" = c.id FROM "Customer" c WHERE a."customerId" IS NULL AND c."storeId" = a."storeId" '
  "AND c.phone = right(regexp_replace(COALESCE(a.\"contactNumber\", ''), '\\D', '', 'g'), 10);")
vals = ",\n  ".join("(" + ", ".join(q(x) for x in t) + ")" for t in links)
w(f"-- Advance adjustments on sales: {len(links)}")
w('INSERT INTO "SaleAdvanceAdjustment" ("saleId", "advanceReceiveId", amount, "adjustedAmount", "previousBalance", "remainingBalance", "storeId", "createdAt")')
w(f"SELECT v.sid, a.id, v.amt, v.amt, v.total, GREATEST(v.total - v.amt, 0), {STORE}, s.\"saleDate\"")
w(f"FROM (VALUES\n  {vals}\n) AS v(sid, vrno, amt, total)")
w(f"JOIN \"Sale\" s ON s.id = v.sid JOIN \"AdvanceReceive\" a ON a.\"storeId\" = {STORE} AND a.specification LIKE 'Migrated advance ' || v.vrno || '%'")
w('ON CONFLICT ("saleId", "advanceReceiveId") DO NOTHING;')
w("")

# ---------------------------------------------------------------- 5. stock: dates, counters, reject reasons, missing tags
cntr = {r["CNTR_ID"]: r["CNTR_NAME"] for r in T("JSP_CNTR_MST")}
ct = {r["CT_ID"]: r for r in T("JSP_CNTR_TRNSFR")}
first, last = {}, {}
for r in sorted(T("JSP_CNTR_TRNS_DTL"), key=lambda x: (real_dt(ct.get(x["CT_ID"], {}).get("CT_DATE")) or B, x["CT_ID"])):
    h = ct.get(r["CT_ID"])
    if not h:
        continue
    bc = r["BCM_BAR_CODE"]
    d = real_dt(h["CT_DATE"])
    first.setdefault(bc, d)
    last[bc] = (h["CNTR_ID_TO"], d, h["CT_VRNO"])
brcd = {r["BCM_BAR_CODE"]: r for r in T("JSP_BRCD_MST")}
sold_on = {}
for t, col in (("JSP_RTL_INVC_ORN", "BCM_BRCD"), ("JSP_RTL_INVC_BRND_PRCS_STN_ORN", "BCM_BRCD")):
    for r in T(t):
        d = sale_dates.get(r["RI_ID"])
        if d and (r[col] not in sold_on or d < sold_on[r[col]]):
            sold_on[r[col]] = d
rej = {}
for r in T("JSP_REJECT_BARCODE"):
    rej[r["BCM_BAR_CODE"]] = (clean(r.get("RJCT_NARR")), real_dt(r.get("RJCT_DATE")))
fy_start = {r["FYR_ID"]: real_dt(r["FYR_START_DATE"]) for r in T("JSP_FYR_MST")}

rows = []
for bc, m in brcd.items():
    created = first.get(bc) or (sold_on.get(bc)) or fy_start.get(m.get("FYR_ID"))
    cid = last[bc][0] if bc in last else m.get("CNTR_ID")
    patch = {"counterId": cid, "counter": cntr.get(cid), "packetCode": m.get("BCM_PKT_CODE")}
    if bc in last:
        patch["lastCounterMove"] = last[bc][2]
    narr = None
    if bc in rej:
        reason, rd = rej[bc]
        narr = f"Rejected in old system{(' on ' + rd.strftime('%d-%m-%Y')) if rd else ''}: {reason or 'no reason recorded'}"
        patch["rejectReason"] = reason
    rows.append((bc, created, json.dumps(patch), narr))
w(f"-- Stock pieces: {len(rows)} (tagging date, current counter, reject reason)")
for i in range(0, len(rows), 500):
    part = rows[i:i + 500]
    vals = ",\n  ".join("(" + ", ".join(q(x) for x in t) + ")" for t in part)
    w('UPDATE "Inventory" t SET "createdAt" = COALESCE(v.d::timestamp, t."createdAt"), '
      '"extraDetails" = COALESCE(t."extraDetails", \'{}\'::jsonb) || v.patch::jsonb, narration = COALESCE(v.narr, t.narration)')
    w(f"FROM (VALUES\n  {vals}\n) AS v(bc, d, patch, narr)")
    w(f'WHERE t."storeId" = {STORE} AND t."barcodeNo" = v.bc;')
w('UPDATE "PurchaseItem" pi SET "createdAt" = i."createdAt" FROM "Inventory" i WHERE i."purchaseItemId" = pi.id AND pi.id BETWEEN 2000000 AND 2999999;')

# the three barcodes that have a barcode-master row but no ornament/branded detail row
acs = {r["BCM_BAR_CODE"]: r for r in T("JSP_ACS_BRCD")}
known = set(r["BCM_BAR_CODE"] for r in T("JSP_ORN_BRCD")) | set(r["BCM_BAR_CODE"] for r in T("JSP_BRND_PRCS_STN_ORN_BRCD"))
missing = [m for bc, m in brcd.items() if bc not in known]
w(f"-- Barcodes missing from the first migration: {len(missing)}")
for k, m in enumerate(missing, 1):
    bc = m["BCM_BAR_CODE"]
    a = acs.get(bc, {})
    extra = {"source": "MIGRATION", "legacyBarcode": bc, "counterId": m.get("CNTR_ID"), "counter": cntr.get(m.get("CNTR_ID")),
             "categoryId": m.get("CTG_ID"), "packetCode": m.get("BCM_PKT_CODE"), "brandId": a.get("BRND_ID"),
             "designId": a.get("DSGN_ID"), "mrp": a.get("AB_MRP"), "type": "ACCESSORY" if a else "MRP",
             "incompleteLegacyRecord": True}
    created = fy_start.get(m.get("FYR_ID"))
    status = "SOLD" if bc in sold_on else ("DAMAGED" if bc in rej else "AVAILABLE")
    pid, iid = 2990000 + k, 4990000 + k
    narr = "Migrated tag with no weight details in the old system - weigh and update before selling."
    w('INSERT INTO "PurchaseItem" (id, "purchaseItemCode", "purchaseId", "itemId", "productId", pieces, "grossWeight", "stoneWeight", "netWeight", "tagNo", "extraDetails", "hsnCode", narration, "createdAt", "updatedAt")')
    w(f"SELECT {pid}, {q('MIG-X%05d' % k)}, 900002, (SELECT id FROM \"Item\" WHERE id = {int(m['ITM_ID'] or 0)}), (SELECT id FROM \"Product\" WHERE id = {int(m['PRDT_ID'] or 0)}), "
      f"{int(a.get('AB_PAIR') or 1)}, 0, 0, 0, {q(bc)}, {q(json.dumps(extra))}::jsonb, '711319', {q(narr)}, {q(created)}, now() "
      f"WHERE NOT EXISTS (SELECT 1 FROM \"PurchaseItem\" WHERE id = {pid});")
    w('INSERT INTO "Inventory" (id, "inventoryCode", "purchaseItemId", "purchaseId", "storeId", "purchaseType", "itemId", "productId", pieces, "grossWeight", "stoneWeight", "netWeight", "tagNo", "barcodeNo", "extraDetails", status, "hsnCode", narration, "createdAt", "updatedAt")')
    w(f"SELECT {iid}, {q('INV-X%05d' % k)}, {pid}, 900002, {STORE}, 'ORNAMENT', pi.\"itemId\", pi.\"productId\", pi.pieces, 0, 0, 0, {q(bc)}, {q(bc)}, pi.\"extraDetails\", '{status}', '711319', {q(narr)}, pi.\"createdAt\", now() "
      f"FROM \"PurchaseItem\" pi WHERE pi.id = {pid} AND NOT EXISTS (SELECT 1 FROM \"Inventory\" WHERE \"storeId\" = {STORE} AND \"barcodeNo\" = {q(bc)});")
w("UPDATE \"Purchase\" p SET date = x.d, \"createdAt\" = x.d FROM (SELECT \"purchaseId\" pid, MIN(\"createdAt\") d FROM \"Inventory\" WHERE \"purchaseId\" IN (900001, 900002) GROUP BY 1) x WHERE p.id = x.pid;")
w("")

# ---------------------------------------------------------------- 6. item default purity
w("-- Item default purity = the purity most of its migrated pieces carry (legacy items had none).")
w('''UPDATE "Item" i SET "purityId" = x.pid FROM (
  SELECT DISTINCT ON ("itemId") "itemId" iid, "purityId" pid FROM "Inventory"
  WHERE "storeId" = 1 AND "itemId" IS NOT NULL AND "purityId" IS NOT NULL
  GROUP BY "itemId", "purityId" ORDER BY "itemId", count(*) DESC, "purityId"
) x WHERE i.id = x.iid AND i."purityId" IS NULL AND i."storeId" = 1;''')
w("")

# ---------------------------------------------------------------- 7. tidy text carried over with CR/LF
w("-- Whitespace clean-up")
w("UPDATE \"Customer\" SET address = NULLIF(btrim(regexp_replace(address, '[\\r\\n]+', ' ', 'g')), '') WHERE address ~ '[\\r\\n]';")
w("UPDATE \"Sale\" SET \"customerAddress\" = NULLIF(btrim(regexp_replace(\"customerAddress\", '[\\r\\n]+', ' ', 'g')), '') WHERE \"customerAddress\" ~ '[\\r\\n]';")
w("UPDATE \"Purchase\" SET address = NULLIF(btrim(regexp_replace(address, '[\\r\\n]+', ' ', 'g')), '') WHERE address ~ '[\\r\\n]';")
w("")
for t in ["SaleOldGold", "SaleAdvanceAdjustment", "Inventory", "PurchaseItem"]:
    w(f"SELECT setval(pg_get_serial_sequence('\"{t}\"','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM \"{t}\"), 1));")
w("COMMIT;")
open(OUT, "w").write("\n".join(out) + "\n")
print("wrote", OUT, "missing tags:", [m["BCM_BAR_CODE"] for m in missing], "advances:", [(r[0], r[1], r[3], r[4]) for r in rows[:0]])
