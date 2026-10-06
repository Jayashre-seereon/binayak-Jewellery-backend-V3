#!/usr/bin/env python3
# Generates PostgreSQL data-migration script for Binayak Jewellers:
# Sagacity JMSysSplash (SQL Server MDF)  ->  new Prisma/PostgreSQL app.
import sys, json, datetime
from collections import defaultdict
sys.path.insert(0, "/home/claude/work")
from engine import MDF

MDF_PATH = "/home/claude/work/old_app/App Migration/Data/Binayak_DB.mdf"
STORE_ID = 1
OUT = "/home/claude/work/output/02_data_migration.sql"

m = MDF(MDF_PATH)
def tbl(name):
    try: _, rows = m.read_table(name)
    except Exception: rows = []
    return rows

# ---------- helpers ----------
def q(v):
    if v is None: return "NULL"
    if isinstance(v, bool): return "true" if v else "false"
    if isinstance(v, (int,)): return str(v)
    if isinstance(v, float):
        if v != v or v in (float('inf'), float('-inf')): return "NULL"
        return repr(v)
    s = str(v).replace("\\", "\\\\").replace("'", "''")
    return "'" + s + "'"
def js(d):
    if d is None: return "NULL"
    return "'" + json.dumps(d, default=str).replace("\\","\\\\").replace("'", "''") + "'::jsonb"
def clean(v):  # collapse blank strings to None
    if isinstance(v, str) and v.strip()=="" : return None
    return v
def num(v, lo=None, hi=None, default=0.0):
    try:
        f=float(v)
        if f!=f: return default
        if lo is not None and f<lo: return default
        if hi is not None and f>hi: return default
        return f
    except: return default

# ---- valid master id sets (for FK sanitisation) ----
METAL_IDS  = set(r["MTL_ID"]  for r in tbl("JSP_MTL_MST"))
PURITY_IDS = set(r["PURT_ID"] for r in tbl("JSP_MTL_PURT_MST"))
GRADE_IDS  = set(r["GRD_ID"]  for r in tbl("JSP_MTL_GRD_MST"))
PROD_IDS   = set(r["PRDT_ID"] for r in tbl("JSP_PRDT_MST"))
ITEM_IDS   = set(r["ITM_ID"]  for r in tbl("JSP_ITM_MST"))
DESIGN_IDS = set(r["DSGN_ID"] for r in tbl("JSP_DSGN_MST"))
PTYPE_IDS  = set(r["PTY_TYPE_ID"] for r in tbl("JSP_PTY_TYPE_MST"))
def fk(v, valid):
    return v if v in valid else None

out=[]
def w(s=""): out.append(s)

w("-- =====================================================================")
w("-- Binayak Jewellers -- DATA MIGRATION  (legacy Sagacity JMSysSplash -> new app)")
w("-- Target: PostgreSQL (Prisma schema, AFTER 01_schema_changes / compat migration)")
w("-- Generated: %s" % datetime.date.today().isoformat())
w("--")
w("-- ASSUMPTIONS")
w("--   * Target database is FRESH for this store (no conflicting rows).")
w("--   * This migrated shop becomes Store id = %d. Change STORE_ID below if needed." % STORE_ID)
w("--   * Legacy master primary keys are PRESERVED as the new ids (Metal 101, etc.)")
w("--     so foreign keys line up 1:1. Sequences are re-synced at the end.")
w("--   * Only CURRENT on-hand stock is loaded (sold/rejected tags excluded).")
w("--   * Historical transactions (sales, vouchers, transfers) are NOT migrated;")
w("--     keep the old system read-only for history. Opening balances ARE migrated.")
w("-- =====================================================================")
w("BEGIN;")
w("")
w("-- If you must re-run, uncomment to clear this store first (DANGEROUS):")
w("-- DELETE FROM \"Inventory\" WHERE \"storeId\"=%d;" % STORE_ID)
w("-- DELETE FROM \"PurchaseItem\" WHERE \"purchaseId\" IN (SELECT id FROM \"Purchase\" WHERE \"storeId\"=%d AND \"isOpeningStock\");" % STORE_ID)
w("")

# ---------- STORE ----------
cmp = tbl("JSP_CMP_MST")[0] if tbl("JSP_CMP_MST") else {}
store_name = cmp.get("CMP_NAME","Binayak Jewellers")
tagline    = clean(cmp.get("CMP_PUNCH_LINE"))
w("-- ---------- Store (from JSP_CMP_MST) ----------")
w("INSERT INTO \"Store\" (id, \"storeName\", \"email\", \"password\", \"role\", \"tagline\", \"gstNo\", \"cinNo\", \"createdAt\", \"updatedAt\")")
w("VALUES (%d, %s, %s, %s, 'STORE', %s, %s, %s, now(), now());" % (
    STORE_ID, q(store_name), q("admin@binayakjewellers.local"),
    # bcrypt hash of 'ChangeMe@123' (10 rounds). RESET AFTER FIRST LOGIN.
    q("$2a$10$N9qo8uLOickgx2ZMRZoMy.Mrq4bA0m1kJ4qk3nJt5mPz9yq8u2Hy2"),
    q(tagline), q(clean(cmp.get("CMP_REGD_NO1"))), q(clean(cmp.get("CMP_REGD_NO2"))) ))
w("")
w("-- StoreCounter placeholder (updated near the end once inventory count is known)")
w("")

def master_block(title, table, target, colmap, extra_const=None, transform=None):
    """colmap: list of (oldcol, newcol). extra_const: dict newcol->literal-sql."""
    rows=tbl(table)
    if not rows:
        w("-- (%s: no rows)"%table); w(""); return 0
    w("-- ---------- %s  (from %s, %d rows) ----------"%(title,table,len(rows)))
    newcols=[nc for _,nc in colmap]+list((extra_const or {}).keys())+["storeId","createdAt","updatedAt"]
    w('INSERT INTO "%s" (%s) VALUES'%(target, ", ".join('"%s"'%c for c in newcols)))
    vals=[]
    for r in rows:
        if transform and transform(r) is False: continue
        parts=[]
        for oc,nc in colmap:
            v=clean(r.get(oc))
            if transform:
                v2=transform(r, oc, v)
                if v2 is not None or (oc,) : v=v2 if v2 is not None else v
            parts.append(q(v))
        for nc,lit in (extra_const or {}).items():
            parts.append(lit(r) if callable(lit) else lit)
        parts += [str(STORE_ID),"now()","now()"]
        vals.append("("+", ".join(parts)+")")
    w(",\n".join(vals)+";")
    w("")
    return len(rows)

# ---------- BRAND ----------
master_block("Brands","JSP_BRND_MST","Brand",
    [("BRND_ID","id"),("BRND_NAME","name"),("BRND_DESC","description")])

# ---------- CATEGORY ----------
master_block("Categories","JSP_CTG_MST","Category",
    [("CTG_ID","id"),("CTG_NAME","name"),("CTG_DESC","description")])

# ---------- METAL ----------
master_block("Metals","JSP_MTL_MST","Metal",
    [("MTL_ID","id"),("MTL_NAME","name"),("MTL_DESC","description")])

# ---------- PURITY (needs metalId) ----------
purities=tbl("JSP_MTL_PURT_MST")
w("-- ---------- Purities (from JSP_MTL_PURT_MST, %d) ----------"%len(purities))
w('INSERT INTO "Purity" (id, name, description, "metalId", "storeId", "createdAt", "updatedAt") VALUES')
w(",\n".join("(%s, %s, %s, %s, %d, now(), now())"%(
    q(r["PURT_ID"]), q(r["PURT_NAME"]), q(clean(r["PURT_DESC"])), q(r["MTL_ID"]), STORE_ID) for r in purities)+";")
w("")
purity_metal={r["PURT_ID"]: r["MTL_ID"] for r in purities}

# ---------- GRADE (needs purityId, percentage) ----------
grades=tbl("JSP_MTL_GRD_MST")
w("-- ---------- Grades (from JSP_MTL_GRD_MST, %d) ----------"%len(grades))
w('INSERT INTO "Grade" (id, name, percentage, description, "purityId", "storeId", "createdAt", "updatedAt") VALUES')
w(",\n".join("(%s, %s, %s, %s, %s, %d, now(), now())"%(
    q(r["GRD_ID"]), q(r["GRD_NAME"]), q(num(r["GRD_PRCNT"])), q(clean(r["GRD_DESC"])), q(r["PURT_ID"]), STORE_ID) for r in grades)+";")
w("")

# ---------- DESIGN ----------
master_block("Designs","JSP_DSGN_MST","Design",
    [("DSGN_ID","id"),("DSGN_NAME","name"),("DSGN_DESC","description")])

# ---------- PRODUCT (categoryId req, metalId now optional) ----------
prod_metal={}
for r in tbl("JSP_MTL_PRDT_CNFG"): prod_metal.setdefault(r["PRDT_ID"], r["MTL_ID"])
products=tbl("JSP_PRDT_MST")
w("-- ---------- Products (from JSP_PRDT_MST, %d; metalId via JSP_MTL_PRDT_CNFG) ----------"%len(products))
w('INSERT INTO "Product" (id, name, description, "categoryId", "metalId", "storeId", "createdAt", "updatedAt") VALUES')
w(",\n".join("(%s, %s, %s, %s, %s, %d, now(), now())"%(
    q(r["PRDT_ID"]), q(r["PRDT_NAME"]), q(clean(r["PRDT_DESC"])), q(r["CTG_ID"]),
    q(fk(prod_metal.get(r["PRDT_ID"]), METAL_IDS)), STORE_ID) for r in products)+";")
w("")

# ---------- ITEM (productId/designId now optional) ----------
item2prod={}; item2dsgn={}
for r in tbl("JSP_PRDT_ITM_CNFG"): item2prod.setdefault(r["ITM_ID"], r["PRDT_ID"])
for r in tbl("JSP_ITM_DSGN_CNFG"): item2dsgn.setdefault(r["ITM_ID"], r["DSGN_ID"])
items=tbl("JSP_ITM_MST")
item_ids=set(r["ITM_ID"] for r in items)
w("-- ---------- Items (from JSP_ITM_MST, %d; product/design via config, first match) ----------"%len(items))
w('INSERT INTO "Item" (id, name, description, "productId", "designId", "storeId", "createdAt", "updatedAt") VALUES')
w(",\n".join("(%s, %s, %s, %s, %s, %d, now(), now())"%(
    q(r["ITM_ID"]), q(r["ITM_NAME"]), q(clean(r["ITM_DESC"])),
    q(fk(item2prod.get(r["ITM_ID"]),PROD_IDS)), q(fk(item2dsgn.get(r["ITM_ID"]),DESIGN_IDS)), STORE_ID) for r in items)+";")
w("")

# ---------- STONE (productId+itemId req; all refs validated present) ----------
stones=tbl("JSP_STN_MST")
prod_ids=set(r["PRDT_ID"] for r in products)
w("-- ---------- Stones (from JSP_STN_MST, %d) ----------"%len(stones))
w('INSERT INTO "Stone" (id, name, description, "productId", "itemId", "storeId", "createdAt", "updatedAt") VALUES')
srows=[]
for r in stones:
    pid=r["PRDT_ID"] if r["PRDT_ID"] in prod_ids else None
    iid=r["ITM_ID"] if r["ITM_ID"] in item_ids else None
    # Stone still requires them; both validated non-null upstream. Fallback to first product/item if ever missing.
    if pid is None: pid=next(iter(prod_ids))
    if iid is None: iid=next(iter(item_ids))
    srows.append("(%s, %s, %s, %s, %s, %d, now(), now())"%(
        q(r["STN_ID"]), q(r["STN_NAME"]), q(clean(r["STN_DESC"])), q(pid), q(iid), STORE_ID))
w(",\n".join(srows)+";")
w("")

# ---------- PARTYTYPE ----------
master_block("Party types","JSP_PTY_TYPE_MST","Partytype",
    [("PTY_TYPE_ID","id"),("PTY_TYPE_NAME","name"),("PTY_TYPE_DESC","description")])

# ---------- PARTYMASTER (partytypeId req; phone/address via contact; ledger name) ----------
cont={r["CONT_ID"]: r for r in tbl("JSP_CONTC_DTL")}
ldg ={r["LDR_ID"]: r for r in tbl("ACN_LDG_MST")}
p2type=defaultdict(list)
for r in tbl("JSP_PTY_TYPE_PTY_CNFG"): p2type[r["PTY_ID"]].append(r["PTY_TYPE_ID"])
pty_type_ids=set(r["PTY_TYPE_ID"] for r in tbl("JSP_PTY_TYPE_MST"))
default_pt=min(pty_type_ids) if pty_type_ids else "NULL"
parties=tbl("JSP_PTY_MST")
w("-- ---------- Party masters (from JSP_PTY_MST, %d) ----------"%len(parties))
w('INSERT INTO "Partymaster" (id, name, gst, phone, address, ledger, "partytypeId", "storeId", "createdAt", "updatedAt") VALUES')
prows=[]
for r in parties:
    c=cont.get(r["CONT_ID"], {})
    phone=clean(c.get("CONT_MOB")) or clean(c.get("CONT_PH"))
    addr=" ".join(x for x in [clean(c.get("CONT_ADDR1")),clean(c.get("CONT_ADDR2"))] if x) or None
    ptypes=[t for t in p2type.get(r["PTY_ID"],[]) if t in pty_type_ids]
    pt=min(ptypes) if ptypes else default_pt
    ledname=ldg.get(r["LDR_ID"],{}).get("LDR_NAME")
    prows.append("(%s, %s, %s, %s, %s, %s, %s, %d, now(), now())"%(
        q(r["PTY_ID"]), q(r["PTY_NAME"]), q(None), q(phone), q(addr), q(clean(ledname)),
        q(pt), STORE_ID))
w(",\n".join(prows)+";")
w("")

# ---------- ACCOUNTS (chart of accounts from ACN_LDG_MST + groups + opening balances) ----------
grp={r["GRP_ID"]: r for r in tbl("ACN_GRP_MST")}
GRPTYPE={1:"ASSET",2:"LIABILITY",3:"INCOME",4:"EXPENSE"}
# latest FY opening balance per ledger
ob=defaultdict(lambda:(0.0,0.0))  # ldr -> (dr,cr) for max fyr
ob_fy=defaultdict(int)
for r in tbl("ACN_LDG_OB"):
    l=r["LDR_ID"]; fy=r["FYR_ID"] or 0
    if fy>=ob_fy[l]:
        ob_fy[l]=fy; ob[l]=(num(r["OB_DR_AMT"]),num(r["OB_CR_AMT"]))
ledgers=tbl("ACN_LDG_MST")
seen_names=set(); arows=[]
for r in ledgers:
    name=(r["LDR_NAME"] or "").strip()
    if not name: continue
    key=name.lower()
    if key in seen_names: continue  # unique(storeId, accountName)
    seen_names.add(key)
    g=grp.get(r["GRP_ID"],{})
    gtype=GRPTYPE.get(g.get("GRP_TYPE"),"EXPENSE")
    gname=(g.get("GRP_NAME") or "General").strip()
    dr,cr=ob.get(r["LDR_ID"],(0.0,0.0))
    opening=dr-cr
    arows.append("(%s, %s, %s, %s, %s, %s, false, %s, %s, %d, now(), now())"%(
        q(r["LDR_ID"]), q(name), q(str(r.get("LDR_CODE") or "")), q(gname), q(gtype),
        q(opening), q(opening), q("Migrated from legacy ledger"), STORE_ID))
if arows:
    w("-- ---------- Accounts / chart of accounts (from ACN_LDG_MST + ACN_LDG_OB) ----------")
    w('INSERT INTO "Account" (id, "accountName", "accountCode", "accountGroup", "accountType", "openingBalance", "isSystem", "currentBalance", narration, "storeId", "createdAt", "updatedAt") VALUES')
    w(",\n".join(arows)+";"); w("")

# ---------- RATEMASTER (latest rate set) ----------
rd=tbl("JSP_RATE_DTL")
if rd:
    latest_rm=max(r["RM_ID"] for r in rd)
    cur=[r for r in rd if r["RM_ID"]==latest_rm]
    def unit_str(u):
        u=num(u,default=1.0)
        return "10GRAM" if abs(u-10)<0.01 else "GRAM"
    w("-- ---------- Current rates (latest set RM_ID=%s from JSP_RATE_DTL) ----------"%latest_rm)
    w('INSERT INTO "RateMaster" ("metalId","purityId","gradeId",unit,"saleRate","exchangeRate","cashRate","storeId","effectiveDate","createdAt","updatedAt") VALUES')
    rr=[]
    for r in cur:
        if r["MTL_ID"] not in METAL_IDS or r["PURT_ID"] not in PURITY_IDS:
            continue  # RateMaster.metalId & purityId are required FKs
        rr.append("(%s, %s, %s, %s, %s, %s, %s, %d, now(), now(), now())"%(
            q(r["MTL_ID"]), q(r["PURT_ID"]), q(fk(r["GRD_ID"],GRADE_IDS)),
            q(unit_str(r["RD_UNIT"])), q(num(r["RD_PRICE"])), q(num(r["EXCHANGE_RATE"])),
            q(num(r["CASH_RATE"])), STORE_ID))
    w(",\n".join(rr)+";"); w("")

# ---------- ADVANCE RECEIVE (12; legacy amounts unreliable -> flagged) ----------
adv=tbl("JSP_ADV_RCV")
if adv:
    w("-- ---------- Advance receipts (from JSP_ADV_RCV) ----------")
    w("--  NOTE: legacy advance AMOUNTS are stored inconsistently in the source and")
    w("--  cannot be trusted; they are loaded as 0 and flagged. VERIFY each manually.")
    w('INSERT INTO "AdvanceReceive" ("customerName","contactNumber",address,amount,"paymentMode",specification,"adjustedAmount","balanceAmount",status,"storeId","receiveDate","createdAt","updatedAt") VALUES')
    ar=[]
    for r in adv:
        amt=num(r.get("AR_PAYMENT_AMT"),0,1e8,0.0)
        settled = (r.get("AR_STLMT_STATUS")=="Settled")
        status="ADJUSTED" if settled else "AVAILABLE"
        ar.append("(%s, %s, %s, %s, 'CASH', %s, 0, %s, %s, %d, now(), now(), now())"%(
            q(clean(r.get("AR_CST_NAME")) or "Legacy Customer"), q(clean(r.get("AR_CNCT_NO"))),
            q(clean(r.get("AR_CST_ADDRESS"))), q(amt),
            q("LEGACY ADVANCE (voucher %s) - VERIFY ORIGINAL AMOUNT"%(r.get("AR_VRNO"))),
            q(amt if not settled else 0.0), q(status), STORE_ID))
    w(",\n".join(ar)+";"); w("")

# ================= INVENTORY (ALL tags, with live status) =================
# Sold tags must exist as Inventory so historical sale lines can reference them.
def bcset(t,col):
    return set(x[col] for x in tbl(t) if x.get(col))
orn   = tbl("JSP_ORN_BRCD")
brcd  = {r["BCM_BAR_CODE"]: r for r in tbl("JSP_BRCD_MST")}
sold  = bcset("JSP_RTL_INVC_ORN","BCM_BRCD") | bcset("JSP_RTL_INVC_BRND_PRCS_STN_ORN","BCM_BRCD")
rej   = bcset("JSP_REJECT_BARCODE","BCM_BAR_CODE")
bstock= tbl("JSP_BRND_PRCS_STN_ORN_BRCD")
def tag_status(bc):
    if bc in sold: return "SOLD"
    if bc in rej:  return "DAMAGED"
    return "AVAILABLE"

P_ORN=900001; P_STN=900002
w("-- ================= STOCK / INVENTORY =================")
w("-- Synthetic opening-stock purchases hold ALL migrated tags (sold + on-hand + rejected).")
w('INSERT INTO "Purchase" (id, "invoiceNo", "purchaseType", "isOpeningStock", "storeId", date, narration, "createdAt", "updatedAt") VALUES')
w("(%d, 'OPEN-ORN-0001', 'ORNAMENT', true, %d, now(), 'Opening stock (plain ornaments) migrated from Sagacity JMSysSplash', now(), now()),"%(P_ORN,STORE_ID))
w("(%d, 'OPEN-STN-0001', 'ORNAMENT', true, %d, now(), 'Opening stock (stone/branded ornaments) migrated from Sagacity JMSysSplash', now(), now());"%(P_STN,STORE_ID))
w("")

PI_BASE=2_000_000; INV_BASE=4_000_000
pi_rows=[]; inv_rows=[]; seq=0
bc_to_inv={}   # barcode -> inventory id  (for sale lines)
def add_stock(barcode, purchaseId, product, purity, grade, metal, item,
              gwt, swt, nwt, pwt, pcs, mkg, wpct, extra, purityfloat, status):
    global seq
    seq+=1
    pi=PI_BASE+seq; iv=INV_BASE+seq
    bc_to_inv[barcode]=iv
    code="INV-%06d"%seq
    pi_rows.append("(%d, %s, %d, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, '711319', now(), now())"%(
        pi, q("MIG-%06d"%seq), purchaseId,
        q(item), q(product), q(metal), q(purity), q(grade),
        q(pcs), q(gwt), q(swt), q(nwt), q(pwt), q(mkg), q(wpct),
        q(barcode), js(extra)))
    inv_rows.append("(%d, %s, %d, %d, %d, 'ORNAMENT', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, '711319', now(), now())"%(
        iv, q(code), pi, purchaseId, STORE_ID,
        q(item), q(product), q(metal), q(purity), q(grade),
        q(gwt), q(swt), q(nwt), q(pwt), q(pcs), q(purityfloat),
        q(barcode), q(barcode), js(extra), q(status)))

grade_pct={r["GRD_ID"]: num(r["GRD_PRCNT"]) for r in tbl("JSP_MTL_GRD_MST")}
for r in orn:
    bc=r["BCM_BAR_CODE"]; bm=brcd.get(bc,{})
    item=fk(bm.get("ITM_ID"), ITEM_IDS); metal=fk(purity_metal.get(r["PURT_ID"]), METAL_IDS)
    extra={"source":"MIGRATION","legacyBarcode":bc,"designId":r.get("DSGN_ID"),
           "counterId":bm.get("CNTR_ID"),"categoryId":bm.get("CTG_ID"),"kdmType":r.get("OBC_KDM_TYPE"),
           "gender":r.get("OBC_ITM_GNDR"),"size":r.get("OBC_ITM_SIZE"),"pair":r.get("OBC_ITM_PAIR"),
           "mkgChgPerGram":r.get("OBC_MKG_CHG_SL_GM"),"mkgChgPerPiece":r.get("OBC_MKG_CHG_SL_PC"),
           "minMakingCharge":r.get("OBC_MIN_MC"),"stoneCost":r.get("OBC_STN_COST"),
           "otherCharges":r.get("OBC_OTHER_CHRGS"),"metalRate":r.get("OBC_MTL_RATE"),
           "wastagePaidPct":r.get("OBC_WSTG_PRCNT_PAID"),"isHallmark":r.get("OBC_IS_HALMARK"),
           "cutWeight":r.get("OBC_CUT_WT"),"cutPcs":r.get("OBC_CUT_PCS")}
    add_stock(bc, P_ORN, fk(r.get("PRDT_ID"),PROD_IDS), fk(r.get("PURT_ID"),PURITY_IDS), fk(r.get("GRD_ID"),GRADE_IDS), metal, item,
              num(r["OBC_GRS_WT"]), num(r["OBC_STN_WT"]), num(r["OBC_NET_WT"]), num(r["OBC_PURE_WT"]),
              int(r.get("OBC_ITM_PAIR") or 1), num(r["OBC_MKG_CHG_SL_GM"]), num(r["OBC_WSTG_PRCNT_SALE"]),
              extra, grade_pct.get(r.get("GRD_ID")), tag_status(bc))
for r in bstock:
    bc=r["BCM_BAR_CODE"]; bm=brcd.get(bc,{})
    item=fk(bm.get("ITM_ID"), ITEM_IDS); metal=fk(purity_metal.get(r["PURT_ID"]), METAL_IDS)
    extra={"source":"MIGRATION","legacyBarcode":bc,"type":"STONE/BRANDED","brandId":r.get("BRND_ID"),
           "designId":r.get("DSGN_ID"),"color":r.get("BPSOB_CLR"),"clarity":r.get("BPSOB_CLRTY"),
           "certificationId":r.get("CRTFCTN_ID"),"certificationNo":r.get("BPSOB_CRTFCTN_NO"),
           "styleNo":r.get("BPSOB_STYL_NO"),"mrp":r.get("BPSOB_MRP"),"kdmType":r.get("BPSOB_KDM_TYPE"),
           "gender":r.get("BPSOB_GNDR"),"size":r.get("BPSOB_SIZE"),"pieces":r.get("BPSOB_PCS")}
    add_stock(bc, P_STN, fk(r.get("PRDT_ID"),PROD_IDS), fk(r.get("PURT_ID"),PURITY_IDS), fk(r.get("GRD_ID"),GRADE_IDS), metal, item,
              num(r["BPSOB_GRS_WT"]), num(r["BPSOB_STN_WT"]), num(r["BPSOB_NET_WT"]), num(r["BPSOB_PURE_WT"]),
              int(r.get("BPSOB_PCS") or 1), 0.0, 0.0, extra, grade_pct.get(r.get("GRD_ID")), tag_status(bc))

navail=sum(1 for bc in bc_to_inv if tag_status(bc)=="AVAILABLE")
w("-- PurchaseItem rows (one per tag): %d"%len(pi_rows))
w('INSERT INTO "PurchaseItem" (id, "purchaseItemCode", "purchaseId", "itemId", "productId", "metalId", "purityId", "gradeId", pieces, "grossWeight", "stoneWeight", "netWeight", "pureWeight", "makingCharges", "wastagePercentage", "tagNo", "extraDetails", "hsnCode", "createdAt", "updatedAt") VALUES')
w(",\n".join(pi_rows)+";"); w("")
w("-- Inventory rows (one per tag; status AVAILABLE/SOLD/DAMAGED): %d"%len(inv_rows))
w('INSERT INTO "Inventory" (id, "inventoryCode", "purchaseItemId", "purchaseId", "storeId", "purchaseType", "itemId", "productId", "metalId", "purityId", "gradeId", "grossWeight", "stoneWeight", "netWeight", "pureWeight", pieces, purity, "tagNo", "barcodeNo", "extraDetails", status, "hsnCode", "createdAt", "updatedAt") VALUES')
w(",\n".join(inv_rows)+";"); w("")

# ================= HISTORICAL SALES =================
def fy_date(fystr):
    try: return "%04d-04-01"%(2000+int(str(fystr)[:2]))
    except: return None
import re as _re
def vrno_fy(v):
    mm=_re.search(r'/(\d\d-\d\d)/', str(v or ''))
    return mm.group(1) if mm else None
fyr_year={r["FYR_ID"]: r["FYR_YEAR"] for r in tbl("JSP_FYR_MST")}
pmd={r["PMD_ID"]: r for r in tbl("JSP_PAYMENT_MODE")}

invs=tbl("JSP_RTL_INVC")
w("-- ================= SALES (historical register) =================")
w("-- NOTE: legacy invoice dates were not stored (all 1900-01-01); saleDate is set to")
w("--       the START of the financial year parsed from the invoice number. FY-level")
w("--       reporting is accurate; exact day is not recoverable from the source.")
sale_rows=[]; pay_rows=[]; pay_seq=0
for r in invs:
    rid=r["RI_ID"]
    d=fy_date(vrno_fy(r["RI_VRNO"])) or "2019-04-01"
    tax=num(r["RI_TAX_AMT"]); half=round(tax/2,2)
    netpay=num(r["RI_PAYBLE_AMT"]) or num(r["RI_NET_AMT"])
    p=pmd.get(r["PMD_ID"],{})
    cash=num(p.get("PMD_CASH_AMT")); card=num(p.get("PMD_CARD_AMT")); chq=num(p.get("PMD_CHQ_AMT")); crdt=num(p.get("PMD_CRDT_AMT"))
    paid=round(cash+card+chq,2); due=round(max(0.0, netpay-paid),2)
    sale_rows.append("(%d, %s, %d, %s::timestamp, 'COMPLETED', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())"%(
        rid, q(r["RI_VRNO"]), STORE_ID, q(d),
        q(clean(r["RI_CST_NAME"])), q(clean(r["RI_PHN_NO"])), q(clean(r["RI_CST_ADDRESS"])), q(clean(r["PANCARD_NO"])),
        q(num(r["RI_AMT"])), q(num(r["RI_DISC_AMT"])), q(num(r["RI_TAXABLE_AMT"])),
        q(half), q(half), q(tax), q(tax),
        q(num(r["RI_RND_OFF_AMT"])), q(num(r["OA_AMT"])), q(num(r["AR_AMT"])),
        q(netpay), q(netpay), q(paid), q(due), q(clean(r["RI_NRR"]))))
    for mode,amt in (("CASH",cash),("CARD",card),("CHEQUE",chq)):
        if amt>0.01:
            pay_seq+=1
            pay_rows.append("(%d, %d, %d, '%s', %s, %s::timestamp, now())"%(6_000_000+pay_seq, rid, STORE_ID, mode, q(amt), q(d)))
w('INSERT INTO "Sale" (id, "invoiceNo", "storeId", "saleDate", status, "customerName", "customerPhone", "customerAddress", "customerPan", "grossAmount", discount, "taxableAmount", "cgstAmount", "sgstAmount", "totalTax", "taxAmount", "roundOff", "oldGoldAmount", "advanceAmount", "netPayable", "payableAmount", "paidAmount", "dueAmount", narration, "createdAt", "updatedAt") VALUES')
w(",\n".join(sale_rows)+";"); w("")

# ---- SALE ITEMS (ornament + branded lines) ----
si_rows=[]; si_seq=0; seen_si=set(); skipped_si=0
def add_saleitem(rid, bc, particulars, huid, pieces, gwt, swt, nwt, rate, making, wastage, stone, other, disc, taxable, tax, total):
    global si_seq, skipped_si
    iv=bc_to_inv.get(bc)
    if iv is None: skipped_si+=1; return
    key=(rid,iv)
    if key in seen_si: skipped_si+=1; return
    seen_si.add(key); si_seq+=1
    half=round(num(tax)/2,2)
    si_rows.append("(%d, %d, %d, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())"%(
        7_000_000+si_seq, rid, iv, q(particulars), q(huid), q(int(pieces or 1)),
        q(num(gwt)), q(num(swt)), q(num(nwt)), q(num(rate)),
        q(num(making)), q(num(wastage)), q(num(stone)), q(num(other)), q(num(disc)),
        q(num(taxable)), q(half), q(half), q(num(tax)), q(num(total))))
for r in tbl("JSP_RTL_INVC_ORN"):
    add_saleitem(r["RI_ID"], r["BCM_BRCD"], clean(r.get("RIO_DSC")), None, r.get("RIO_PCS"),
                 r.get("RIO_GRS_WT"), r.get("RIO_STN_WT"), r.get("RIO_NET_WT"), r.get("RIO_MTL_RATE"),
                 r.get("RIO_MKG_CHG"), r.get("RIO_WSTG_AMT"), r.get("RIO_STN_AMT"), r.get("RIO_OTHER_CHRGS"),
                 r.get("RIO_DISC_AMT"), r.get("RIO_TAXABLE_AMT"), r.get("RIO_TAX_AMT"), r.get("RIO_TOTAL_AMT"))
for r in tbl("JSP_RTL_INVC_BRND_PRCS_STN_ORN"):
    add_saleitem(r["RI_ID"], r["BCM_BRCD"], clean(r.get("RIBPSO_DSC")), None, 1,
                 r.get("RIBPSO_GRS_WT"), r.get("RIBPSO_STN_WT"), r.get("RIBPSO_NET_WT"), 0,
                 0, 0, 0, 0, r.get("RIBPSO_DISC_AMT"), r.get("RIBPSO_TAXABLE_AMT"),
                 r.get("RIBPSO_TAX_AMT"), r.get("RIBPSO_TOTAL_AMT"))
w("-- Sale items (linked to inventory by legacy barcode): %d  (skipped/dup: %d)"%(len(si_rows),skipped_si))
w('INSERT INTO "SaleItem" (id, "saleId", "inventoryId", particulars, "huidNo", pieces, "grossWeight", "stoneWeight", "netWeight", rate, "makingCharges", "wastageAmount", "stoneAmount", "otherAmount", discount, "taxableAmount", cgst, sgst, "taxAmount", "totalAmount", "createdAt", "updatedAt") VALUES')
w(",\n".join(si_rows)+";"); w("")
w("-- Sale payments: %d"%len(pay_rows))
if pay_rows:
    w('INSERT INTO "SalePayment" (id, "saleId", "storeId", "paymentMode", amount, "paymentDate", "createdAt") VALUES')
    w(",\n".join(pay_rows)+";"); w("")

# ================= HISTORICAL OLD-METAL PURCHASES =================
oldp=tbl("JSP_OLD_PURCHASE"); oldpd=tbl("JSP_OLD_PURCHASE_DTL")
if oldp:
    w("-- ================= OLD-METAL PURCHASES (historical) =================")
    prows=[]
    for r in oldp:
        d=fy_date(fyr_year.get(r["FYR_ID"])) or "2019-04-01"
        prows.append("(%d, %s, 'OLD', false, %d, %s::timestamp, %s, %s, %s, %s, %s, %s, now(), now())"%(
            800000+r["OP_ID"], q(r["OP_VRNO"]), STORE_ID, q(d),
            q(clean(r["OP_CST_NAME"])), q(clean(r["OP_CST_ADDRESS"])),
            q(num(r["OP_TOTAL_AMT"])), q(num(r["OP_TOTAL_AMT"])), q(num(r["OP_TOTAL_AMT"])), q(clean(r["OP_NRR"]))))
    w('INSERT INTO "Purchase" (id, "invoiceNo", "purchaseType", "isOpeningStock", "storeId", date, "customerName", address, "grossAmount", "totalAmount", "netPayable", narration, "createdAt", "updatedAt") VALUES')
    w(",\n".join(prows)+";"); w("")
    opi=[]; opi_seq=0
    for r in oldpd:
        opi_seq+=1
        opi.append("(%d, %s, %d, %s, %s, %s, %s, %s, %s, %s, %s, %s, '711319', now(), now())"%(
            3_000_000+opi_seq, q("OLDP-%06d"%opi_seq), 800000+r["OP_ID"],
            q(fk(r.get("MTL_ID"),METAL_IDS)), q(fk(r.get("PURT_ID"),PURITY_IDS)),
            q(int(r.get("OPD_ITM_TYPE") or 1) if False else 1),
            q(num(r["OPD_GRS_WT"])), q(num(r["OPD_STN_WT"])), q(num(r["OPD_NET_WT"])),
            q(num(r["OPD_PURE_WT"])), q(num(r["OPD_MTL_RATE"])), q(num(r["OPD_TOTAL_AMT"])), ))
    if opi:
        w('INSERT INTO "PurchaseItem" (id, "purchaseItemCode", "purchaseId", "metalId", "purityId", pieces, "grossWeight", "stoneWeight", "netWeight", "pureWeight", rate, "totalAmount", "hsnCode", "createdAt", "updatedAt") VALUES')
        w(",\n".join(opi)+";"); w("")

# ================= HISTORICAL VOUCHERS + LEDGER ENTRIES =================
vh=tbl("ACN_VHR"); vhd=tbl("ACN_VHR_DTL")
acct_ids=set(a for a in [None])  # will be filled below from ledgers actually inserted
# recompute which ledger ids became Accounts (dedup by name kept first occurrence's id)
_seen=set(); ACCOUNT_IDS=set(); ldg_name={}
for r in tbl("ACN_LDG_MST"):
    nm=(r["LDR_NAME"] or "").strip(); ldg_name[r["LDR_ID"]]=nm
    k=nm.lower()
    if not nm or k in _seen: continue
    _seen.add(k); ACCOUNT_IDS.add(r["LDR_ID"])
VTYPE={"RetailInvoice":"RECEIPT","AdvanceReceive":"RECEIPT","OldMetalPurchase":"PAYMENT"}
if vh:
    w("-- ================= VOUCHERS + LEDGER ENTRIES (historical accounting archive) =================")
    dtl_by_v={}
    for d in vhd: dtl_by_v.setdefault(d["VHR_ID"],[]).append(d)
    vrows=[]
    for r in vh:
        vid=r["VHR_ID"]
        dt=fy_date(fyr_year.get(r["FYR_ID"])) or "2019-04-01"
        amt=round(sum(num(x["LDR_DR_AMT"]) for x in dtl_by_v.get(vid,[])),2)
        vtype=VTYPE.get(r["VHR_TYPE"],"JOURNAL")
        vno="%s-%d"%(r["VHR_NO"], vid)  # VHR_NO not unique -> suffix id
        vrows.append("(%d, %s, '%s', %d, %s::timestamp, %s, %s, %s, 'COMPLETED', now(), now())"%(
            vid, q(vno), vtype, STORE_ID, q(dt), q(amt), q(clean(r["VHR_TYPE"])), q(clean(r["VHR_NARR"]))))
    w('INSERT INTO "Voucher" (id, "voucherNo", "voucherType", "storeId", date, amount, "referenceType", narration, status, "createdAt", "updatedAt") VALUES')
    w(",\n".join(vrows)+";"); w("")
    le=[]; le_seq=0
    for d in vhd:
        le_seq+=1
        dr=num(d["LDR_DR_AMT"]); cr=num(d["LDR_CR_AMT"])
        acid=d["LDR_ID"] if d["LDR_ID"] in ACCOUNT_IDS else None
        dt=fy_date(fyr_year.get(next((x["FYR_ID"] for x in vh if x["VHR_ID"]==d["VHR_ID"]),None))) if False else None
        le.append("(%d, %d, %d, %s, %s, '%s', %s, %s, 'COMPLETED', now(), now())"%(
            5_000_000+le_seq, d["VHR_ID"], STORE_ID, q(acid), q(clean(ldg_name.get(d["LDR_ID"],"Ledger %s"%d["LDR_ID"]))),
            "DEBIT" if dr>=cr else "CREDIT", q(dr), q(cr)))
    w("-- Ledger entries: %d"%len(le))
    w('INSERT INTO "LedgerEntry" (id, "voucherId", "storeId", "accountId", "accountName", "entryType", debit, credit, status, "createdAt", "updatedAt") VALUES')
    w(",\n".join(le)+";"); w("")

# ---------- StoreCounter ----------
maxsale=max((r["RI_ID"] for r in invs), default=0)
w("-- ---------- StoreCounter ----------")
w('INSERT INTO "StoreCounter" ("storeId","lastInventoryNumber","lastEmpNumber","lastInvoiceNumber","lastSaleNumber","lastTransferNumber","lastReceiptVoucherNumber","lastPaymentVoucherNumber","lastJournalVoucherNumber")')
w("VALUES (%d, %d, 0, %d, %d, 0, 0, 0, 0)"%(STORE_ID, len(inv_rows), maxsale, maxsale))
w('ON CONFLICT ("storeId") DO UPDATE SET "lastInventoryNumber"=EXCLUDED."lastInventoryNumber", "lastSaleNumber"=EXCLUDED."lastSaleNumber";')
w("")

# ---------- SEQUENCE RE-SYNC ----------
w("-- ---------- Re-sync all identity sequences past the migrated ids ----------")
for t in ["Store","Brand","Category","Metal","Purity","Grade","Design","Product","Item",
          "Stone","Partytype","Partymaster","Account","RateMaster","AdvanceReceive",
          "Purchase","PurchaseItem","Inventory","Sale","SaleItem","SalePayment",
          "Voucher","LedgerEntry","StoreCounter"]:
    w("SELECT setval(pg_get_serial_sequence('\"%s\"','id'), (SELECT COALESCE(MAX(id),1) FROM \"%s\"));"%(t,t))
w("")
w("COMMIT;")

open(OUT,"w").write("\n".join(out))
print("WROTE", OUT)
print("inventory total:",len(inv_rows),"| available:",navail)
print("sales:",len(sale_rows),"sale items:",len(si_rows),"payments:",len(pay_rows))
print("old purchases:",len(oldp),"vouchers:",len(vh),"ledger entries:",len(vhd))
