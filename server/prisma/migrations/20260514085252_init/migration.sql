-- CreateEnum
CREATE TYPE "Role" AS ENUM ('salesman', 'driver', 'super_admin', 'sales_manager', 'inventory_manager', 'finance_manager', 'pos_cashier');

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('ur', 'en');

-- CreateEnum
CREATE TYPE "UnitType" AS ENUM ('bottle', 'crate', 'carton');

-- CreateEnum
CREATE TYPE "RetailerStatus" AS ENUM ('active', 'suspended', 'inactive');

-- CreateEnum
CREATE TYPE "HealthState" AS ENUM ('active', 'growing', 'at_risk', 'inactive');

-- CreateEnum
CREATE TYPE "VisitType" AS ENUM ('order', 'no_order');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending_approval', 'pending', 'assigned', 'delivered', 'partial', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('pct', 'pkr', 'none');

-- CreateEnum
CREATE TYPE "DiscountApprovalStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('delivered', 'partial', 'failed', 'not_home');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'credit', 'digital');

-- CreateEnum
CREATE TYPE "POSPaymentMethod" AS ENUM ('cash', 'digital');

-- CreateEnum
CREATE TYPE "PeriodType" AS ENUM ('daily', 'weekly', 'monthly');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('grn', 'load', 'deliver', 'return', 'adjustment', 'pos_sale');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "pin_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "language" "Language" NOT NULL DEFAULT 'en',
    "max_discount_pct" DECIMAL(5,2),
    "max_discount_pkr" DECIMAL(14,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zones" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_zones" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "zone_id" UUID NOT NULL,
    "assigned_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "user_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retailers" (
    "id" UUID NOT NULL,
    "shop_name" TEXT NOT NULL,
    "owner_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "gps_lat" DECIMAL(10,7) NOT NULL,
    "gps_lng" DECIMAL(10,7) NOT NULL,
    "zone_id" UUID NOT NULL,
    "primary_salesman_id" UUID NOT NULL,
    "credit_limit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit_limit_approved" BOOLEAN NOT NULL DEFAULT false,
    "credit_limit_approved_by" UUID,
    "outstanding_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "overdue_threshold_days" INTEGER,
    "health_state" "HealthState" NOT NULL DEFAULT 'active',
    "status" "RetailerStatus" NOT NULL DEFAULT 'active',
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retailers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "unit_type" "UnitType" NOT NULL,
    "base_price" DECIMAL(14,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retailer_prices" (
    "id" UUID NOT NULL,
    "retailer_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "special_price" DECIMAL(14,2) NOT NULL,
    "set_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retailer_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_stock" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity_on_hand" INTEGER NOT NULL DEFAULT 0,
    "low_stock_threshold" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesman_targets" (
    "id" UUID NOT NULL,
    "salesman_id" UUID NOT NULL,
    "period_type" "PeriodType" NOT NULL,
    "target_order_value_pkr" DECIMAL(14,2) NOT NULL,
    "target_visit_count" INTEGER NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),

    CONSTRAINT "salesman_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visits" (
    "id" UUID NOT NULL,
    "salesman_id" UUID NOT NULL,
    "retailer_id" UUID NOT NULL,
    "order_id" UUID,
    "visit_type" "VisitType" NOT NULL,
    "note" TEXT,
    "visited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "retailer_id" UUID NOT NULL,
    "salesman_id" UUID NOT NULL,
    "zone_id" UUID NOT NULL,
    "driver_id" UUID,
    "status" "OrderStatus" NOT NULL DEFAULT 'pending',
    "order_date" DATE NOT NULL,
    "delivery_date" DATE NOT NULL,
    "note" VARCHAR(200),
    "total_value_pkr" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "max_retries" INTEGER,
    "assigned_at" TIMESTAMP(3),
    "assigned_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "unit_type" "UnitType" NOT NULL,
    "qty_ordered" INTEGER NOT NULL,
    "qty_delivered" INTEGER,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "special_price_applied" DECIMAL(14,2),
    "discount_type" "DiscountType" NOT NULL DEFAULT 'none',
    "discount_value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "effective_unit_price" DECIMAL(14,2) NOT NULL,
    "price_revised_on_sync" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discount_approvals" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "reviewed_by" UUID,
    "status" "DiscountApprovalStatus" NOT NULL DEFAULT 'pending',
    "rejection_reason" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMP(3),

    CONSTRAINT "discount_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_proofs" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "status" "DeliveryStatus" NOT NULL,
    "reason_code" TEXT,
    "photo_url" TEXT,
    "photo_uploaded" BOOLEAN NOT NULL DEFAULT false,
    "gps_lat" DECIMAL(10,7),
    "gps_lng" DECIMAL(10,7),
    "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "override_by" UUID,
    "override_reason" TEXT,

    CONSTRAINT "delivery_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "retailer_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "amount_pkr" DECIMAL(14,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference_no" TEXT,
    "due_date" DATE,
    "collected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reconciled" BOOLEAN NOT NULL DEFAULT false,
    "reconciled_at" TIMESTAMP(3),
    "reconciled_by" UUID,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_stock" (
    "id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "shift_date" DATE NOT NULL,
    "product_id" UUID NOT NULL,
    "unit_type" "UnitType" NOT NULL,
    "qty_loaded" INTEGER NOT NULL,
    "qty_delivered" INTEGER NOT NULL DEFAULT 0,
    "qty_returned_logged" INTEGER,
    "qty_returned_verified" INTEGER,
    "discrepancy_flag" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "movement_type" "StockMovementType" NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_type" "UnitType" NOT NULL,
    "reference_id" UUID,
    "actor_id" UUID NOT NULL,
    "reason_code" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grn_records" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "qty_received" INTEGER NOT NULL,
    "unit_type" "UnitType" NOT NULL,
    "supplier_ref" TEXT,
    "received_by" UUID NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grn_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_sales" (
    "id" UUID NOT NULL,
    "cashier_id" UUID NOT NULL,
    "total_pkr" DECIMAL(14,2) NOT NULL,
    "discount_pkr" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "payment_method" "POSPaymentMethod" NOT NULL,
    "reference_no" TEXT,
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "voided_by" UUID,
    "voided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_sale_items" (
    "id" UUID NOT NULL,
    "pos_sale_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "unit_type" "UnitType" NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "effective_price" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "pos_sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_alerts" (
    "id" UUID NOT NULL,
    "alert_type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "triggered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seen_by" JSONB NOT NULL DEFAULT '[]',
    "resolved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "system_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_settings" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "logo_url" TEXT,
    "address" TEXT,
    "ntn" TEXT,
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "city" TEXT NOT NULL,
    "delivery_retry_limit" INTEGER NOT NULL DEFAULT 2,
    "alert_balance_threshold" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "idle_salesman_check_time" TEXT NOT NULL DEFAULT '12:00',
    "zone_failure_threshold" INTEGER NOT NULL DEFAULT 3,
    "pos_cashier_discount_limit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "company_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_is_active_is_deleted_idx" ON "users"("is_active", "is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "zones_name_city_key" ON "zones"("name", "city");

-- CreateIndex
CREATE INDEX "user_zones_zone_id_is_active_idx" ON "user_zones"("zone_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "user_zones_user_id_zone_id_key" ON "user_zones"("user_id", "zone_id");

-- CreateIndex
CREATE INDEX "retailers_zone_id_idx" ON "retailers"("zone_id");

-- CreateIndex
CREATE INDEX "retailers_primary_salesman_id_idx" ON "retailers"("primary_salesman_id");

-- CreateIndex
CREATE INDEX "retailers_health_state_idx" ON "retailers"("health_state");

-- CreateIndex
CREATE INDEX "retailers_status_idx" ON "retailers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

-- CreateIndex
CREATE INDEX "products_is_active_is_deleted_idx" ON "products"("is_active", "is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "retailer_prices_retailer_id_product_id_key" ON "retailer_prices"("retailer_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stock_product_id_key" ON "warehouse_stock"("product_id");

-- CreateIndex
CREATE INDEX "salesman_targets_salesman_id_period_type_effective_from_idx" ON "salesman_targets"("salesman_id", "period_type", "effective_from");

-- CreateIndex
CREATE INDEX "visits_salesman_id_visited_at_idx" ON "visits"("salesman_id", "visited_at");

-- CreateIndex
CREATE INDEX "visits_retailer_id_visited_at_idx" ON "visits"("retailer_id", "visited_at");

-- CreateIndex
CREATE INDEX "orders_salesman_id_order_date_idx" ON "orders"("salesman_id", "order_date");

-- CreateIndex
CREATE INDEX "orders_driver_id_delivery_date_idx" ON "orders"("driver_id", "delivery_date");

-- CreateIndex
CREATE INDEX "orders_retailer_id_order_date_idx" ON "orders"("retailer_id", "order_date");

-- CreateIndex
CREATE INDEX "orders_zone_id_order_date_idx" ON "orders"("zone_id", "order_date");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_product_id_idx" ON "order_items"("product_id");

-- CreateIndex
CREATE INDEX "discount_approvals_status_idx" ON "discount_approvals"("status");

-- CreateIndex
CREATE INDEX "discount_approvals_order_id_idx" ON "discount_approvals"("order_id");

-- CreateIndex
CREATE INDEX "delivery_proofs_order_id_idx" ON "delivery_proofs"("order_id");

-- CreateIndex
CREATE INDEX "delivery_proofs_driver_id_confirmed_at_idx" ON "delivery_proofs"("driver_id", "confirmed_at");

-- CreateIndex
CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");

-- CreateIndex
CREATE INDEX "payments_driver_id_collected_at_idx" ON "payments"("driver_id", "collected_at");

-- CreateIndex
CREATE INDEX "payments_retailer_id_collected_at_idx" ON "payments"("retailer_id", "collected_at");

-- CreateIndex
CREATE INDEX "payments_reconciled_idx" ON "payments"("reconciled");

-- CreateIndex
CREATE INDEX "vehicle_stock_shift_date_idx" ON "vehicle_stock"("shift_date");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_stock_driver_id_shift_date_product_id_unit_type_key" ON "vehicle_stock"("driver_id", "shift_date", "product_id", "unit_type");

-- CreateIndex
CREATE INDEX "stock_movements_product_id_created_at_idx" ON "stock_movements"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_movements_movement_type_created_at_idx" ON "stock_movements"("movement_type", "created_at");

-- CreateIndex
CREATE INDEX "grn_records_product_id_received_at_idx" ON "grn_records"("product_id", "received_at");

-- CreateIndex
CREATE INDEX "pos_sales_cashier_id_created_at_idx" ON "pos_sales"("cashier_id", "created_at");

-- CreateIndex
CREATE INDEX "pos_sales_created_at_idx" ON "pos_sales"("created_at");

-- CreateIndex
CREATE INDEX "pos_sale_items_pos_sale_id_idx" ON "pos_sale_items"("pos_sale_id");

-- CreateIndex
CREATE INDEX "system_alerts_alert_type_resolved_idx" ON "system_alerts"("alert_type", "resolved");

-- CreateIndex
CREATE INDEX "system_alerts_triggered_at_idx" ON "system_alerts"("triggered_at");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_created_at_idx" ON "audit_log"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "user_zones" ADD CONSTRAINT "user_zones_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_zones" ADD CONSTRAINT "user_zones_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retailers" ADD CONSTRAINT "retailers_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retailers" ADD CONSTRAINT "retailers_primary_salesman_id_fkey" FOREIGN KEY ("primary_salesman_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retailers" ADD CONSTRAINT "retailers_credit_limit_approved_by_fkey" FOREIGN KEY ("credit_limit_approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retailer_prices" ADD CONSTRAINT "retailer_prices_retailer_id_fkey" FOREIGN KEY ("retailer_id") REFERENCES "retailers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retailer_prices" ADD CONSTRAINT "retailer_prices_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retailer_prices" ADD CONSTRAINT "retailer_prices_set_by_fkey" FOREIGN KEY ("set_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stock" ADD CONSTRAINT "warehouse_stock_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salesman_targets" ADD CONSTRAINT "salesman_targets_salesman_id_fkey" FOREIGN KEY ("salesman_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_salesman_id_fkey" FOREIGN KEY ("salesman_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_retailer_id_fkey" FOREIGN KEY ("retailer_id") REFERENCES "retailers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_retailer_id_fkey" FOREIGN KEY ("retailer_id") REFERENCES "retailers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_salesman_id_fkey" FOREIGN KEY ("salesman_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_approvals" ADD CONSTRAINT "discount_approvals_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_approvals" ADD CONSTRAINT "discount_approvals_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_approvals" ADD CONSTRAINT "discount_approvals_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_override_by_fkey" FOREIGN KEY ("override_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_retailer_id_fkey" FOREIGN KEY ("retailer_id") REFERENCES "retailers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_reconciled_by_fkey" FOREIGN KEY ("reconciled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_stock" ADD CONSTRAINT "vehicle_stock_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_stock" ADD CONSTRAINT "vehicle_stock_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_records" ADD CONSTRAINT "grn_records_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_records" ADD CONSTRAINT "grn_records_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_sale_items" ADD CONSTRAINT "pos_sale_items_pos_sale_id_fkey" FOREIGN KEY ("pos_sale_id") REFERENCES "pos_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_sale_items" ADD CONSTRAINT "pos_sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
