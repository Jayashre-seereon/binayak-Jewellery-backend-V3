-- v3.1: barcodes move from Product to Item (item code for MRP goods; every piece keeps its own
-- Inventory.barcodeNo), plus token versioning for immediate session revocation. Idempotent.

ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "barcode" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Item_storeId_barcode_key" ON "Item"("storeId", "barcode");

-- Carry any product barcode over to the product's single item (only when unambiguous), then drop it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Product' AND column_name = 'barcode') THEN
    UPDATE "Item" i SET "barcode" = p."barcode"
    FROM "Product" p
    WHERE p."barcode" IS NOT NULL AND i."productId" = p.id AND i."barcode" IS NULL
      AND (SELECT count(*) FROM "Item" x WHERE x."productId" = p.id) = 1;
  END IF;
END $$;
DROP INDEX IF EXISTS "Product_storeId_barcode_key";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "barcode";

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Store" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
