-- Serves outstandingAgeing(): oldest unreconciled credit payment per retailer
-- (filters retailer_id + method + reconciled, aggregates collected_at).
-- Replaces a per-retailer N+1 with a single grouped query.
CREATE INDEX "payments_retailer_id_method_reconciled_collected_at_idx" ON "payments"("retailer_id", "method", "reconciled", "collected_at");
