ALTER TABLE "Inventory" ADD COLUMN "availablePieces" INTEGER;

UPDATE "Inventory"
SET "availablePieces" = CASE
  WHEN "status" = 'SOLD' THEN 0
  WHEN "status" = 'AVAILABLE' THEN GREATEST(COALESCE("pieces", 1), 0)
  ELSE 0
END;

ALTER TABLE "Inventory" ALTER COLUMN "availablePieces" SET DEFAULT 1;
ALTER TABLE "Inventory" ALTER COLUMN "availablePieces" SET NOT NULL;
