import bcrypt from 'bcrypt';
import { Language, PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();

// Fixed UUID for the singleton company_settings row so re-runs are idempotent
const COMPANY_SETTINGS_ID = '00000000-0000-0000-0000-000000000001';

async function main(): Promise<void> {
  // In production the bootstrap admin credential and the dev sample users must
  // never come from hardcoded defaults — see the seed credential guard below.
  const isProduction = process.env.NODE_ENV === 'production';

  // Company settings — single row keyed by a well-known UUID
  await prisma.companySettings.upsert({
    where: { id: COMPANY_SETTINGS_ID },
    update: {},
    create: {
      id: COMPANY_SETTINGS_ID,
      name: 'Acme Beverages',
      city: 'Lahore',
      currency: 'PKR',
      address: 'TBD',
      ntn: 'TBD',
      contactPhone: '042-0000000',
      contactEmail: 'info@example.com',
    },
  });

  // Default Super Admin so the system can be administered after first deploy.
  // PIN should be rotated immediately after first login (SRS SM05).
  //
  // Production MUST supply the credential via the environment so we never ship a
  // publicly-known PIN. Locally we fall back to a well-known dev credential.
  const DEV_SUPERADMIN_PIN = '000000';
  const superAdminPhone = process.env.SEED_SUPERADMIN_PHONE ?? '03001234567';
  const superAdminPin = process.env.SEED_SUPERADMIN_PIN ?? DEV_SUPERADMIN_PIN;

  if (isProduction) {
    if (!process.env.SEED_SUPERADMIN_PHONE || !process.env.SEED_SUPERADMIN_PIN) {
      throw new Error(
        'Refusing to seed a default Super Admin in production. ' +
          'Set SEED_SUPERADMIN_PHONE and a 6-digit SEED_SUPERADMIN_PIN before running the seed.',
      );
    }
    if (!/^\d{6}$/.test(superAdminPin) || superAdminPin === DEV_SUPERADMIN_PIN) {
      throw new Error(
        'SEED_SUPERADMIN_PIN must be exactly 6 digits and must not be the well-known dev default.',
      );
    }
  }

  const pinHash = await bcrypt.hash(superAdminPin, 12);

  await prisma.user.upsert({
    where: { phone: superAdminPhone },
    update: {},
    create: {
      name: 'Super Admin',
      phone: superAdminPhone,
      role: Role.super_admin,
      pinHash,
      language: Language.en,
    },
  });

  // Sample field users for mobile app dev/testing — NEVER seeded in production
  // (they ship known PINs). upsert sets pinHash on BOTH create and update so
  // re-seeding restores a known PIN even if the rows already exist.
  const salesmanPin = '111111';
  const driverPin = '222222';

  if (!isProduction) {
    await prisma.user.upsert({
      where: { phone: '03001111111' },
      update: { pinHash: await bcrypt.hash(salesmanPin, 12) },
      create: {
        name: 'Ahmed Ali',
        phone: '03001111111',
        role: Role.salesman,
        pinHash: await bcrypt.hash(salesmanPin, 12),
        language: Language.en,
        maxDiscountPct: 5,
        maxDiscountPkr: 500,
      },
    });

    await prisma.user.upsert({
      where: { phone: '03002222222' },
      update: { pinHash: await bcrypt.hash(driverPin, 12) },
      create: {
        name: 'Bilal Khan',
        phone: '03002222222',
        role: Role.driver,
        pinHash: await bcrypt.hash(driverPin, 12),
        language: Language.en,
      },
    });
  }

  // Two sample zones from SRS D1 (Gulberg, Model Town in Lahore)
  await prisma.zone.upsert({
    where: { name_city: { name: 'Gulberg', city: 'Lahore' } },
    update: {},
    create: { name: 'Gulberg', city: 'Lahore', description: 'Gulberg commercial belt' },
  });
  await prisma.zone.upsert({
    where: { name_city: { name: 'Model Town', city: 'Lahore' } },
    update: {},
    create: { name: 'Model Town', city: 'Lahore', description: 'Model Town residential' },
  });

  // Upstream principal company (one supplier; schema is multi-ready) — S10.
  await prisma.supplier.upsert({
    where: { name: 'Mezan Beverages (Private) Limited' },
    update: {},
    create: { name: 'Mezan Beverages (Private) Limited' },
  });

  // Default expense categories. "Fuel & Freight" is the distributor's OWN
  // transport cost (distinct from the company-billed fare on the ledger).
  for (const name of [
    'Salaries',
    'Rent',
    'Fuel & Freight',
    'Utilities',
    'Vehicle Maintenance',
    'Miscellaneous',
  ]) {
    await prisma.expenseCategory.upsert({ where: { name }, update: {}, create: { name } });
  }

  console.log('Seed complete.');
  if (isProduction) {
    console.log(`Super Admin → phone=${superAdminPhone} (PIN set from SEED_SUPERADMIN_PIN; rotate after first login)`);
  } else {
    console.log(`Super Admin → phone=${superAdminPhone} pin=${superAdminPin} (change immediately)`);
    console.log(`Salesman    → phone=03001111111 pin=${salesmanPin}`);
    console.log(`Driver      → phone=03002222222 pin=${driverPin}`);
  }
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
