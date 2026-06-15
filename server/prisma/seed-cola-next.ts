// Idempotent seed for the Cola Next purchase-matrix catalog (flavour × pack-size).
// Safe to re-run: upserts each product by SKU and ensures a warehouse_stock row.
//
// The flavour/pack-size LABELS here MUST match the web grid constants in
// web/src/pages/finance/purchasesMatrix.ts exactly, since the grid maps a cell
// to a product by (flavour, packSize). To enable a grid cell, add the size to a
// flavour's list below (and to the web PACK_SIZES if it's a brand-new column).
//
//   run:  cd server && node --import tsx prisma/seed-cola-next.ts

import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma';

// Valid (flavour → pack-sizes) cells. Grey cells in the sheet are simply absent.
const MATRIX: Record<string, string[]> = {
  COLA: ['2.25LTR', '1.5LTR', '1LTR', '500ML', 'Can 250ml', '300ML', 'STROM 300ml', 'WT 1.5', 'WT 500'],
  Fizup: ['2.25LTR', '1.5LTR', '1LTR', '500ML', 'Can 250ml', '300ML'],
  RANGOO: ['1.5LTR', '1LTR', '300ML'],
  'Dare Next': ['1.5LTR', '1LTR'],
  LYCHEE: ['1LTR', 'Can 250ml', '300ML'],
  QAR: ['1.5LTR', '1LTR', '300ML'],
  Apple: ['1LTR', 'Can 250ml', '300ML'],
  'Fizup Mint': ['1.5LTR', '1LTR', '300ML'],
  'Zero Cola': ['1.5LTR', '1LTR', '500ML', 'Can 250ml'],
  'Zero Fizup': ['1.5LTR', '1LTR', 'Can 250ml'],
  ICS: ['1LTR'],
};

const slug = (s: string) => s.replace(/\s+/g, '').toUpperCase();

async function main() {
  let created = 0;
  let kept = 0;
  for (const [flavour, sizes] of Object.entries(MATRIX)) {
    for (const packSize of sizes) {
      const sku = `CN-${slug(flavour)}-${slug(packSize)}`;
      const existing = await prisma.product.findUnique({ where: { sku } });
      const product = await prisma.product.upsert({
        where: { sku },
        update: { flavour, packSize, name: `${flavour} ${packSize}`, isDeleted: false },
        create: {
          sku,
          name: `${flavour} ${packSize}`,
          category: 'Cola Next',
          flavour,
          packSize,
          unitType: 'bottle',
          basePrice: new Prisma.Decimal(0),
        },
      });
      // Ensure the warehouse_stock row exists so it shows in inventory + can receive.
      await prisma.warehouseStock.upsert({
        where: { productId: product.id },
        update: {},
        create: { productId: product.id, quantityOnHand: 0, lowStockThreshold: 0 },
      });
      existing ? (kept += 1) : (created += 1);
    }
  }
  console.log(`Cola Next catalog: ${created} created, ${kept} already present.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
