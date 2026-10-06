#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL must be set}"

# P3005 occurs when this app's existing schema has no Prisma migration history.
# The checked-in v3.1 upgrader handles that specific legacy schema and records
# the exact checksums for the migrations shipped with this image.
legacy_schema=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc '
  SELECT to_regclass('\''public."Store"'\'') IS NOT NULL
     AND to_regclass('\''public."Inventory"'\'') IS NOT NULL
     AND to_regclass('\''public."Purchase"'\'') IS NOT NULL
     AND to_regclass('\''public."Item"'\'') IS NOT NULL
     AND to_regclass('\''public."Product"'\'') IS NOT NULL
     AND (
       to_regclass('\''public."_prisma_migrations"'\'') IS NULL
       OR NOT EXISTS (SELECT 1 FROM "_prisma_migrations")
     );
')

if [ "$legacy_schema" = "t" ]; then
  echo "Detected existing Binayak schema without Prisma history; applying the v3.1 baseline upgrade."
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/migration/03_upgrade_to_v3_1.sql
fi

npx prisma migrate deploy
