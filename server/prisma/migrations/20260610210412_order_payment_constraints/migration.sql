-- One payment per order (DR19): replaces the plain index with a UNIQUE one so
-- the duplicate-payment race (two sync retries) is rejected by the database,
-- not just the application-level findFirst guard.
DROP INDEX "payments_order_id_idx";
CREATE UNIQUE INDEX "payments_order_id_key" ON "payments"("order_id");

-- One order per retailer per salesman per business day (SRS D10). A partial
-- unique index so a CANCELLED or FAILED order frees the slot for a replacement
-- the same day. Partial indexes are not expressible in the Prisma schema, so
-- this is hand-authored; do not remove it on a schema-only `migrate dev`.
CREATE UNIQUE INDEX "orders_one_per_retailer_salesman_day"
  ON "orders" ("retailer_id", "salesman_id", "order_date")
  WHERE "status" NOT IN ('cancelled', 'failed');
