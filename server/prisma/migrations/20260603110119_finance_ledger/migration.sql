-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('stock_purchase', 'fare', 'funds_paid', 'incentive', 'discount', 'adjustment', 'opening_balance');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('debit', 'credit');

-- CreateEnum
CREATE TYPE "IncentivePeriod" AS ENUM ('monthly', 'quarterly', 'annual');

-- CreateEnum
CREATE TYPE "ExpensePaymentMethod" AS ENUM ('cash', 'digital', 'cheque', 'credit');

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contact_phone" TEXT,
    "address" TEXT,
    "ntn" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_ledger_entries" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "entry_type" "LedgerEntryType" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount_pkr" DECIMAL(14,2) NOT NULL,
    "entry_date" DATE NOT NULL,
    "reference_no" TEXT,
    "incentive_period" "IncentivePeriod",
    "period_label" TEXT,
    "note" VARCHAR(280),
    "purchase_id" UUID,
    "created_by" UUID NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_purchases" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "purchase_number" VARCHAR(20) NOT NULL,
    "purchase_date" DATE NOT NULL,
    "supplier_ref" TEXT,
    "subtotal_pkr" DECIMAL(14,2) NOT NULL,
    "fare_pkr" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discount_pkr" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_pkr" DECIMAL(14,2) NOT NULL,
    "note" VARCHAR(200),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_purchase_items" (
    "id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "unit_type" "UnitType" NOT NULL,
    "qty_received" INTEGER NOT NULL,
    "unit_cost_pkr" DECIMAL(14,2) NOT NULL,
    "line_total_pkr" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "supplier_purchase_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_counters" (
    "year" INTEGER NOT NULL,
    "last_seq" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_counters_pkey" PRIMARY KEY ("year")
);

-- CreateTable
CREATE TABLE "expense_categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "amount_pkr" DECIMAL(14,2) NOT NULL,
    "expense_date" DATE NOT NULL,
    "payee" TEXT,
    "payment_method" "ExpensePaymentMethod" NOT NULL,
    "reference_no" TEXT,
    "note" VARCHAR(280),
    "receipt_url" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_name_key" ON "suppliers"("name");

-- CreateIndex
CREATE INDEX "supplier_ledger_entries_supplier_id_entry_date_idx" ON "supplier_ledger_entries"("supplier_id", "entry_date");

-- CreateIndex
CREATE INDEX "supplier_ledger_entries_purchase_id_idx" ON "supplier_ledger_entries"("purchase_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_purchases_purchase_number_key" ON "supplier_purchases"("purchase_number");

-- CreateIndex
CREATE INDEX "supplier_purchases_supplier_id_purchase_date_idx" ON "supplier_purchases"("supplier_id", "purchase_date");

-- CreateIndex
CREATE INDEX "supplier_purchase_items_purchase_id_idx" ON "supplier_purchase_items"("purchase_id");

-- CreateIndex
CREATE INDEX "supplier_purchase_items_product_id_idx" ON "supplier_purchase_items"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_name_key" ON "expense_categories"("name");

-- CreateIndex
CREATE INDEX "expenses_expense_date_idx" ON "expenses"("expense_date");

-- CreateIndex
CREATE INDEX "expenses_category_id_expense_date_idx" ON "expenses"("category_id", "expense_date");

-- AddForeignKey
ALTER TABLE "supplier_ledger_entries" ADD CONSTRAINT "supplier_ledger_entries_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_ledger_entries" ADD CONSTRAINT "supplier_ledger_entries_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "supplier_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_ledger_entries" ADD CONSTRAINT "supplier_ledger_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_purchases" ADD CONSTRAINT "supplier_purchases_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_purchases" ADD CONSTRAINT "supplier_purchases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_purchase_items" ADD CONSTRAINT "supplier_purchase_items_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "supplier_purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_purchase_items" ADD CONSTRAINT "supplier_purchase_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
