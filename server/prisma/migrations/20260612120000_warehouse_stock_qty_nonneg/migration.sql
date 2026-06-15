-- INV-1: backstop the application-level guard (warehouse.service.adjustStock and
-- the guarded decrement paths) with a hard DB CHECK so no code path or manual
-- query can drive warehouse on-hand stock below zero.
ALTER TABLE "warehouse_stock"
  ADD CONSTRAINT "warehouse_stock_quantity_on_hand_nonneg" CHECK ("quantity_on_hand" >= 0);
