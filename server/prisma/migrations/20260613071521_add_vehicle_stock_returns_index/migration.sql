-- CreateIndex
CREATE INDEX "vehicle_stock_qty_returned_verified_shift_date_idx" ON "vehicle_stock"("qty_returned_verified", "shift_date");
