# Binayak Jewellers — Data Migration Guide
### Legacy *Sagacity JMSysSplash* (SQL Server) → New Jeweller App (Node/Prisma/PostgreSQL)

Prepared by Seereon · Generated 2026-09-24

---

> **ADDENDUM (v3.1, 05 Oct 2026) — corrections; read this first.**
> 1. **Real dates recovered.** The earlier claim that legacy dates "were not stored" was wrong: the MDF
>    reader swapped the two halves of SQL Server `DATETIME` (time first, then days). Fixed in
>    `tools/engine.py`; every sale, payment, voucher, ledger line, old-metal purchase, advance and stock
>    tag now carries its true date (sales run 01-Apr-2019 → 20-Sep-2026). `old_data_csv/` is regenerated.
> 2. **Advances**: real amounts recovered from their receipt vouchers (12 advances, ₹8,19,700); two are
>    still open (₹60,000, SUMITRA JENA). Their 10 uses on sales are linked (`SaleAdvanceAdjustment`).
> 3. **Old-gold exchange**: the 50 exchanges are linked to their sales (`SaleOldGold`); 3 old-metal
>    purchases left on customer credit in the old books stay open (₹1,60,315) and are flagged.
> 4. **Stock**: the 3 tags the first pass skipped (2 MRP tags, 1 accessory) are added (flagged, no weights);
>    each piece carries its current counter and, if rejected, the reason. Items get a default purity.
> 5. **Customers**: 323 customers backfilled from invoices (one per valid mobile); historical sales linked.
>
> **New install:** restore `database/binayak_v3_1.sql` (or `.dump`) from the delivery — it already contains
> everything above. **Database already loaded with the earlier (Phase-2 / v3) data:** run
> `03_upgrade_to_v3_1.sql` once (idempotent; keeps every row).
> Not migrated (no place in the new model; kept in `old_data_csv/`): stone colour/clarity/cut/shape/sieve
> masters, certification master, counter-transfer history (current counter is kept per piece), old-metal
> issue to artisan (11 rows), estimates (2), legacy users/roles/rights, rate history (legacy rate sets
> carry no dates; the latest set is loaded).

---

> **ADDENDUM (v2 — historical data now included).** This guide's §6 originally scoped the
> migration to masters + live stock + opening balances. The delivered database now **also
> includes the full transaction history**: all 7,170 stock tags (with AVAILABLE/SOLD/DAMAGED
> status), 3,701 sales with 4,714 line items and 4,334 payments, 3,769 accounting vouchers with
> 14,604 ledger entries, and 53 old-metal purchases. Two source limitations to note:
> legacy **invoice dates were not stored** (all 1900-01-01), so `saleDate`/voucher dates are set
> to the **financial-year start** parsed from the document number (FY-level reports are accurate;
> exact day is not recoverable); and the ledger archive coexists with the migrated opening
> balances, so treat opening balances as the anchor for current position and the ledger entries
> as historical drill-down rather than re-summing both.

---

## 1. What was analysed

**Old system** — `App Migration.zip`
- A .NET/WinForms jewellery ERP called **Sagacity JMSysSplash** (compiled DLLs only; no source).
- Data lives in a **SQL Server database file** `Binayak_DB.mdf` (the *Data* folder — the one you told me to use).
- There is no running SQL Server here, so the `.mdf` was parsed **directly at the page level** (a purpose-built reader is included under `tools/`). It recovered the full catalog: **228 user tables, 73 of them populated**.

**New system** — `binayak-jeweller-backend` + `binayak-Jewellery-frontend`
- Node.js + Express + **Prisma ORM on PostgreSQL**.
- A clean, **multi-store** POS / inventory / purchase / sales / accounting app.
- Data model is in `prisma/schema.prisma` (~30 models). Stock is created only through the Purchase module (`Inventory.purchaseItemId` is a required, unique link).

The company record in the old DB is **"Binayak Jewellers"** — this becomes **Store #1** in the new system.

---

## 2. The core structural differences (and how they were resolved)

| # | Old system | New system | Resolution |
|---|------------|-----------|------------|
| 1 | Masters (Item, Product, Design, Metal) are **flat, independent lists** joined by many-to-many config tables. 77 items belong to *several* products. | `Item` requires **one** `productId` + `designId`; `Product` requires a `metalId`. | **Relaxed 3 FKs to optional** (`Product.metalId`, `Item.productId`, `Item.designId`). Safe, backward-compatible. See §4. |
| 2 | Stock tags (`JSP_ORN_BRCD`) exist with **no purchase document**. | `Inventory` must link to a `PurchaseItem` + `Purchase`. | Migration creates **synthetic "opening-stock" purchases** (`Purchase.isOpeningStock = true`) that own the migrated tags. |
| 3 | `JSP_ORN_BRCD` is a **lifetime** tag registry — sold and rejected tags are still in it. | Only *current* stock should exist as `AVAILABLE`. | Loaded **on-hand stock only** = all tags **minus sold** (`JSP_RTL_INVC_ORN`) **minus rejected** (`JSP_REJECT_BARCODE`). |
| 4 | Making charge stored two ways (per-gram *and* per-piece), plus KDM/HUID, gender, size, wastage-paid, stone cost, colour, clarity, certificate no., style no. | New `Inventory` has a leaner column set. | Every legacy-only attribute is preserved in the `Inventory.extraDetails` **JSON** column — nothing is lost. |
| 5 | Retail customers are **not** kept as master records (walk-in shop). | `Customer` master exists. | No customer master to migrate. Customer details live on historical invoices (not migrated — see §6). |

---

## 3. What gets migrated

| New model | Source table(s) | Rows loaded | Notes |
|-----------|-----------------|------------:|-------|
| **Store** | `JSP_CMP_MST` | 1 | "Binayak Jewellers". Login seeded — **reset password on first login**. |
| **Brand** | `JSP_BRND_MST` | 16 | |
| **Category** | `JSP_CTG_MST` | 7 | |
| **Metal** | `JSP_MTL_MST` | 2 | Gold, Silver |
| **Purity** | `JSP_MTL_PURT_MST` | 17 | linked to metal |
| **Grade** | `JSP_MTL_GRD_MST` | 29 | with % fineness |
| **Design** | `JSP_DSGN_MST` | 50 | |
| **Product** | `JSP_PRDT_MST` (+`JSP_MTL_PRDT_CNFG`) | 18 | metal linked where known |
| **Item** | `JSP_ITM_MST` (+config) | 337 | first product/design link where known |
| **Stone** | `JSP_STN_MST` | 50 | |
| **Partytype** | `JSP_PTY_TYPE_MST` | 24 | |
| **Partymaster** | `JSP_PTY_MST` (+`JSP_CONTC_DTL`) | 30 | suppliers/artisans, with phone/address/ledger |
| **Account** | `ACN_LDG_MST` + `ACN_GRP_MST` + `ACN_LDG_OB` | 75 | chart of accounts **with opening balances** (duplicate names merged) |
| **RateMaster** | `JSP_RATE_DTL` (latest set) | 27 | current sale/exchange/cash rates |
| **AdvanceReceive** | `JSP_ADV_RCV` | 12 | ⚠ amounts flagged — see §6 |
| **Purchase** | *synthetic* | 2 | opening-stock carriers |
| **PurchaseItem** | `JSP_ORN_BRCD` + `JSP_BRND_PRCS_STN_ORN_BRCD` | 1,045 | one per on-hand tag |
| **Inventory** | same | **1,045** | **848 plain ornaments + 197 stone/branded**, all `AVAILABLE` |

**Legacy primary keys are preserved** as the new ids (Metal 101/102, Purity 101–117, …) so every foreign key lines up 1:1. Identity sequences are re-synced at the end of the script.

The whole script was **executed against a real PostgreSQL instance built from the actual Prisma migrations** — it loads with **zero foreign-key/orphan errors**.

---

## 4. Code / schema changes (required for a seamless migration)

Two files:
- **`schema.prisma`** — the updated Prisma schema (diff vs. original in `schema.prisma.orig`).
- **`01_schema_changes.sql`** — the equivalent raw SQL (also drop it into `prisma/migrations/` as a new migration).

Changes:
```prisma
model Product {
  metalId Int?          // was: Int   (metal chosen per piece in legacy data)
  metal   Metal?        // was: Metal
}
model Item {
  productId Int?        // was: Int   (legacy items are shared across products)
  product   Product?    // was: Product
  designId  Int?        // was: Int
  design    Design?     // was: Design
}
model Purchase {
  isOpeningStock Boolean @default(false)   // NEW — tags migrated opening stock
}
```
These are **widening** changes (required → optional) plus one new nullable-defaulted column. They do **not** affect existing rows and do **not** require changes to the create endpoints (the UI still supplies these fields for new records). Run `npx prisma generate` after updating the schema.

---

## 5. How to run

> Target a **fresh** database for this store (empty tables, first store = id 1). If your target already has data, read §7 first.

```bash
# 1. Apply the schema changes (choose ONE)
#    a) as a Prisma migration:
mkdir -p prisma/migrations/20260924000000_legacy_migration_compat
cp 01_schema_changes.sql prisma/migrations/20260924000000_legacy_migration_compat/migration.sql
npx prisma migrate deploy
#    b) or straight to the DB:
psql "$DATABASE_URL" -f 01_schema_changes.sql

# 2. Load the data
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 02_data_migration.sql

# 3. Regenerate the Prisma client
npx prisma generate
```
The data script is wrapped in a single `BEGIN … COMMIT`, so any error rolls the whole thing back — safe to re-run after fixing.

**After loading:** log in as the store, open **Inventory** → you should see 1,045 available pieces; open **Accounting** → opening balances are in place. Then **change the store password** (seeded as a placeholder).

---

## 6. What is deliberately **NOT** migrated (and why)

Standard practice for a POS cut-over is to carry **masters + live stock + opening balances**, not full transaction history. The old system stays available read-only for old bills.

Not loaded:
- **Historical sales** (`JSP_RTL_INVC` 3,701 + lines 4,513), **vouchers** (`ACN_VHR` 3,769 + `ACN_VHR_DTL` 14,604), **counter transfers**, **tax lines** (`JSP_TRNS_TAX` 33,854), artisan/hallmark/refiner movements, branch issues — these are history, and their financial effect is already captured in the **opening balances** that *were* migrated.
- **Sold / rejected stock tags** — excluded from inventory by design.
- **Old passwords** — stored with a legacy hash the new app can't use; the store login is re-seeded.

⚠ **Advance receipts** — the 12 rows load, but the **amounts are stored inconsistently in the source** (some are corrupt). They come in flagged (`specification = "LEGACY ADVANCE … VERIFY ORIGINAL AMOUNT"`); **verify each against the old system before adjusting against a sale.**

If you *do* want historical sales/vouchers migrated too, that's a follow-on: the extractor already reads those tables (CSVs are in `old_data_csv/`), and mapping them into `Sale`/`Voucher`/`LedgerEntry` can be scripted the same way.

---

## 7. Re-running for the real cut-over

This was built from the snapshot you shared. On cut-over day the shop will have newer data, so:
1. Take a fresh copy of `Binayak_DB.mdf`.
2. `python3 tools/gen_migration.py` (point `MDF_PATH` at the new file) → regenerates `02_data_migration.sql` with current stock and balances.
3. Load into a **fresh** target DB.

If the target is **not** empty, either truncate the store's tables first (commented `DELETE`s at the top of the data script) or change `STORE_ID` and strip the explicit-id inserts so new ids are assigned — tell me which and I'll produce that variant.

---

## 8. Files in this package

```
00_MIGRATION_GUIDE.md          ← this document
01_schema_changes.sql          ← code/schema updates (required)
02_data_migration.sql          ← the data (validated end-to-end)
schema.prisma                  ← updated Prisma schema
schema.prisma.orig             ← original, for diff
tools/                         ← the MDF reader + SQL generator (re-runnable)
  mdfparse.py  catalog.py  engine.py  gen_migration.py
old_data_csv/                  ← every populated legacy table as CSV (audit/reference)
```
