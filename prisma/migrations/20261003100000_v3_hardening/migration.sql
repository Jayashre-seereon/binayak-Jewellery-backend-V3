-- v3 hardening: security, tenant isolation, business-logic integrity, barcode module.
-- Additive / constraint-loosening only. Existing data is preserved.

-- 1. Optional master links: ON DELETE SET NULL (matches schema.prisma)
ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_metalId_fkey";
ALTER TABLE "Product" ADD CONSTRAINT "Product_metalId_fkey" FOREIGN KEY ("metalId") REFERENCES "Metal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Item" DROP CONSTRAINT IF EXISTS "Item_productId_fkey";
ALTER TABLE "Item" ADD CONSTRAINT "Item_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Item" DROP CONSTRAINT IF EXISTS "Item_designId_fkey";
ALTER TABLE "Item" ADD CONSTRAINT "Item_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. Auth / password lifecycle
ALTER TABLE "User"  ADD COLUMN IF NOT EXISTS "resetTokenExpiry" TIMESTAMP(3);
ALTER TABLE "User"  ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Store" ADD COLUMN IF NOT EXISTS "resetToken" TEXT;
ALTER TABLE "Store" ADD COLUMN IF NOT EXISTS "resetTokenExpiry" TIMESTAMP(3);
ALTER TABLE "Store" ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- 3. Per-store uniqueness (multi-store safe)
DROP INDEX IF EXISTS "Employee_empCode_key";
DROP INDEX IF EXISTS "Employee_email_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Employee_storeId_empCode_key" ON "Employee"("storeId", "empCode");
CREATE UNIQUE INDEX IF NOT EXISTS "Employee_storeId_email_key" ON "Employee"("storeId", "email");
DROP INDEX IF EXISTS "Customer_phone_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Customer_storeId_phone_key" ON "Customer"("storeId", "phone");
ALTER TABLE "StoreCounter" ADD COLUMN IF NOT EXISTS "lastCustomerNumber" INTEGER NOT NULL DEFAULT 0;

-- 4. Sales integrity
CREATE UNIQUE INDEX IF NOT EXISTS "SaleOldGold_saleId_purchaseId_key" ON "SaleOldGold"("saleId", "purchaseId");
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "cancelledReason" TEXT;
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "cancelledBy" TEXT;
ALTER TABLE "SalePayment" ADD COLUMN IF NOT EXISTS "voucherId" INTEGER;
ALTER TABLE "PurchasePayment" ADD COLUMN IF NOT EXISTS "voucherId" INTEGER;

-- 5. Opening balances may be decimal (amounts in paise, metal in grams)
ALTER TABLE "PartyOpeningBalance" ALTER COLUMN "debit" SET DATA TYPE DOUBLE PRECISION;
ALTER TABLE "PartyOpeningBalance" ALTER COLUMN "credit" SET DATA TYPE DOUBLE PRECISION;

-- 6. Barcode module
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "barcode" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Product_storeId_barcode_key" ON "Product"("storeId", "barcode");
CREATE TABLE IF NOT EXISTS "BarcodeConfig" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BarcodeConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BarcodeConfig_storeId_key" ON "BarcodeConfig"("storeId");
DO $$ BEGIN
  ALTER TABLE "BarcodeConfig" ADD CONSTRAINT "BarcodeConfig_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 7. Data correction for accounts migrated from the legacy ledger: classify by legacy group root
UPDATE "Account" SET "accountType" = CASE "accountGroup"
    WHEN 'Accesories Purchase' THEN 'LIABILITY'
    WHEN 'Accessories Purchase' THEN 'EXPENSE'
    WHEN 'Accessories Sale Tax Payble' THEN 'LIABILITY'
    WHEN 'Accessories Sales' THEN 'INCOME'
    WHEN 'Accessories Tax Invoice' THEN 'INCOME'
    WHEN 'Accounting Charges' THEN 'EXPENSE'
    WHEN 'Advance Receive' THEN 'LIABILITY'
    WHEN 'Advance Receive A/c on Gold Scheme' THEN 'ASSET'
    WHEN 'Advertisement Expensses' THEN 'EXPENSE'
    WHEN 'Alloy Purchase' THEN 'LIABILITY'
    WHEN 'Assets' THEN 'ASSET'
    WHEN 'Audit Fees' THEN 'EXPENSE'
    WHEN 'BMC Charges' THEN 'EXPENSE'
    WHEN 'Bank Charges' THEN 'EXPENSE'
    WHEN 'Books & Periodicals' THEN 'EXPENSE'
    WHEN 'Branded Ornament Purchase' THEN 'EXPENSE'
    WHEN 'Branded Ornament Purchase - Gold' THEN 'LIABILITY'
    WHEN 'Branded Ornament Sale' THEN 'INCOME'
    WHEN 'Branded Ornament Sale Tax Payble' THEN 'LIABILITY'
    WHEN 'Branded Ornament Tax Invoice' THEN 'INCOME'
    WHEN 'Branded Precious Ornament Purchase - Gold' THEN 'LIABILITY'
    WHEN 'Branded Precious Stone Ornament Purchase' THEN 'EXPENSE'
    WHEN 'Branded Precious Stone Ornament Sale' THEN 'INCOME'
    WHEN 'Branded Precious Stone Ornament Sale Tax Payble' THEN 'LIABILITY'
    WHEN 'Branded Precious Stone Ornament Tax Invoice' THEN 'INCOME'
    WHEN 'Building' THEN 'ASSET'
    WHEN 'Bullion Purchase' THEN 'EXPENSE'
    WHEN 'Bullion Purchase - Gold' THEN 'EXPENSE'
    WHEN 'Bullion Purchase - Silver' THEN 'EXPENSE'
    WHEN 'Business Promotion' THEN 'EXPENSE'
    WHEN 'Capital' THEN 'LIABILITY'
    WHEN 'Card Account' THEN 'ASSET'
    WHEN 'Card Account - BBSR' THEN 'ASSET'
    WHEN 'Carriage' THEN 'EXPENSE'
    WHEN 'Cash At Bank' THEN 'ASSET'
    WHEN 'Cash In Hand' THEN 'ASSET'
    WHEN 'Computer Consumuable' THEN 'EXPENSE'
    WHEN 'Counter Discount' THEN 'EXPENSE'
    WHEN 'Credit' THEN 'LIABILITY'
    WHEN 'Current Assets' THEN 'ASSET'
    WHEN 'Current Liabilites' THEN 'LIABILITY'
    WHEN 'Direct Expense' THEN 'EXPENSE'
    WHEN 'Direct Incomes' THEN 'INCOME'
    WHEN 'Donation' THEN 'EXPENSE'
    WHEN 'Electicity Expenssess' THEN 'EXPENSE'
    WHEN 'Electrical Expensses' THEN 'EXPENSE'
    WHEN 'Entertainment Expenssess' THEN 'EXPENSE'
    WHEN 'Expense' THEN 'EXPENSE'
    WHEN 'Fixed Assets' THEN 'ASSET'
    WHEN 'Fixed Liabilites' THEN 'LIABILITY'
    WHEN 'Fuel & Lubricants' THEN 'EXPENSE'
    WHEN 'General Expensses' THEN 'EXPENSE'
    WHEN 'Hallmarking Charges Payble' THEN 'LIABILITY'
    WHEN 'Hallmarking Charges Payble - Gold' THEN 'LIABILITY'
    WHEN 'Hallmarking Charges Payble - Gold Precious Stone Ornament' THEN 'LIABILITY'
    WHEN 'Halmarking Charge A/c' THEN 'EXPENSE'
    WHEN 'Income' THEN 'INCOME'
    WHEN 'Indirect Expense' THEN 'EXPENSE'
    WHEN 'Indirect Incomes' THEN 'INCOME'
    WHEN 'Liabilites' THEN 'LIABILITY'
    WHEN 'Loans and Advances' THEN 'ASSET'
    WHEN 'Loans and Liabilites' THEN 'LIABILITY'
    WHEN 'Making Charge Account' THEN 'EXPENSE'
    WHEN 'Making Charge Payable' THEN 'LIABILITY'
    WHEN 'Making Charge Payble -  Gold' THEN 'LIABILITY'
    WHEN 'Making Charge Payble - Gold Precious Stone Ornament' THEN 'LIABILITY'
    WHEN 'Making Charge Payble - Silver' THEN 'LIABILITY'
    WHEN 'Membership & Subscription Fees' THEN 'EXPENSE'
    WHEN 'Mess Expensses' THEN 'EXPENSE'
    WHEN 'Old Ornament Purchase' THEN 'EXPENSE'
    WHEN 'Ornament Purchase - Gold' THEN 'LIABILITY'
    WHEN 'Ornament Purchase - Silver' THEN 'LIABILITY'
    WHEN 'Ornament Purchase A/C' THEN 'EXPENSE'
    WHEN 'Ornament Purchase(Sundry Creditor)A/c' THEN 'LIABILITY'
    WHEN 'Ornament Sale' THEN 'INCOME'
    WHEN 'Ornament Sale Tax Payble' THEN 'LIABILITY'
    WHEN 'Ornament Tax Invoice' THEN 'INCOME'
    WHEN 'Paybles' THEN 'LIABILITY'
    WHEN 'Postage & Telegrame' THEN 'EXPENSE'
    WHEN 'Precious Stone Ornament Purchase' THEN 'EXPENSE'
    WHEN 'Precious Stone Ornament Sale' THEN 'INCOME'
    WHEN 'Precious Stone Ornament Sale Tax Payble' THEN 'LIABILITY'
    WHEN 'Precious Stone Ornament Tax Invoice' THEN 'INCOME'
    WHEN 'Precious Stone Purchase' THEN 'EXPENSE'
    WHEN 'Precious Stone Sale Tax Payble' THEN 'LIABILITY'
    WHEN 'Precious Stone Sales' THEN 'INCOME'
    WHEN 'Precious Stone Tax Invoice' THEN 'INCOME'
    WHEN 'Printing & Stationaries' THEN 'EXPENSE'
    WHEN 'Puja Expenssess' THEN 'EXPENSE'
    WHEN 'Purchase A/c' THEN 'EXPENSE'
    WHEN 'Pure Purchase' THEN 'EXPENSE'
    WHEN 'Refining Charge Account' THEN 'EXPENSE'
    WHEN 'Refining Charge Payble' THEN 'LIABILITY'
    WHEN 'Refining Charge Payble - Gold' THEN 'LIABILITY'
    WHEN 'Refining Charge Payble - Silver' THEN 'LIABILITY'
    WHEN 'Repair & Maintenance' THEN 'EXPENSE'
    WHEN 'Retail Sale' THEN 'INCOME'
    WHEN 'Round Off A/c' THEN 'EXPENSE'
    WHEN 'Sale Tax Payble' THEN 'LIABILITY'
    WHEN 'Shop Expensses' THEN 'EXPENSE'
    WHEN 'Shop Rent' THEN 'EXPENSE'
    WHEN 'Staff Bonus Expensses' THEN 'EXPENSE'
    WHEN 'Staff Incentive' THEN 'EXPENSE'
    WHEN 'Staff LIC' THEN 'EXPENSE'
    WHEN 'Staff Salary' THEN 'EXPENSE'
    WHEN 'Staff Uniform' THEN 'EXPENSE'
    WHEN 'Staff Welfare' THEN 'EXPENSE'
    WHEN 'Sundry Creditors' THEN 'LIABILITY'
    WHEN 'Sundry Creditors (other)' THEN 'LIABILITY'
    WHEN 'Sundry Debtors' THEN 'ASSET'
    WHEN 'TDS Payable F Yr 2016-17' THEN 'LIABILITY'
    WHEN 'Tax Invoice Party' THEN 'ASSET'
    WHEN 'Tax Invoice Sale' THEN 'INCOME'
    WHEN 'Telephone Charges' THEN 'EXPENSE'
    WHEN 'Traveling & Conveyance' THEN 'EXPENSE'
    WHEN 'VAT Payble' THEN 'LIABILITY'
    ELSE "accountType" END
WHERE "narration" = 'Migrated from legacy ledger';
