-- ============================================================================
-- Prisma migration: legacy-data compatibility
-- Place at: prisma/migrations/20260924000000_legacy_migration_compat/migration.sql
-- (or run manually, then `prisma migrate resolve`).
--
-- Widens three required FKs to optional and adds an opening-stock flag, so the
-- flat/independent legacy masters (Sagacity JMSysSplash) migrate losslessly.
-- All changes are backward compatible: existing rows already have values, and
-- the create endpoints still supply these fields for new records.
-- ============================================================================

-- Product.metalId : required -> optional
ALTER TABLE "Product" ALTER COLUMN "metalId" DROP NOT NULL;

-- Item.productId, Item.designId : required -> optional
ALTER TABLE "Item" ALTER COLUMN "productId" DROP NOT NULL;
ALTER TABLE "Item" ALTER COLUMN "designId" DROP NOT NULL;

-- Purchase.isOpeningStock : new flag for synthetic opening-stock purchases
ALTER TABLE "Purchase" ADD COLUMN "isOpeningStock" BOOLEAN NOT NULL DEFAULT false;
