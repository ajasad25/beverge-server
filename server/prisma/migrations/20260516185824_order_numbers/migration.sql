-- Human-readable order numbers (ORD-YYYY-NNNNNN). The UUID id stays the real
-- PK; order_number is a display/reference label only.

-- 1. Per-year counter table.
CREATE TABLE "order_counters" (
    "year" INTEGER NOT NULL,
    "last_seq" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "order_counters_pkey" PRIMARY KEY ("year")
);

-- 2. Add the column nullable so we can backfill existing rows.
ALTER TABLE "orders" ADD COLUMN "order_number" VARCHAR(20);

-- 3. Backfill: per order_date year, number existing orders in creation order
--    (created_at, then id as a stable tiebreak).
WITH numbered AS (
    SELECT
        id,
        EXTRACT(YEAR FROM order_date)::int AS yr,
        ROW_NUMBER() OVER (
            PARTITION BY EXTRACT(YEAR FROM order_date)
            ORDER BY created_at, id
        ) AS seq
    FROM "orders"
)
UPDATE "orders" o
SET "order_number" = 'ORD-' || numbered.yr || '-' || LPAD(numbered.seq::text, 6, '0')
FROM numbered
WHERE o.id = numbered.id;

-- 4. Seed order_counters from the backfilled max sequence per year.
INSERT INTO "order_counters" ("year", "last_seq")
SELECT
    EXTRACT(YEAR FROM order_date)::int AS yr,
    COUNT(*)::int AS last_seq
FROM "orders"
GROUP BY EXTRACT(YEAR FROM order_date);

-- 5. Lock the column down + enforce uniqueness.
ALTER TABLE "orders" ALTER COLUMN "order_number" SET NOT NULL;
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");
