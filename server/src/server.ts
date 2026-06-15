import { buildApp } from './app';
import { env } from './lib/env';
import { prisma } from './lib/prisma';
import { startScheduler, stopScheduler } from './jobs/scheduler';

async function main(): Promise<void> {
  const app = buildApp();

  // Open the DB connection (and prepared-statement session) before accepting
  // traffic. Prisma connects lazily otherwise, so the first request after a
  // deploy/restart eats a ~1.5s cold-connect. Warming here moves that cost to
  // startup where no user is waiting.
  await prisma.$connect();

  const server = app.listen(env.PORT, () => {
    console.log(`API listening on http://localhost:${env.PORT} [${env.NODE_ENV}]`);
  });

  // Cron jobs only run in long-lived dev/prod processes — skip in test runs
  // (and in any future ephemeral CLI tooling that imports server.ts).
  if (env.NODE_ENV !== 'test') {
    startScheduler();
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}, shutting down...`);
    stopScheduler();
    server.close(() => console.log('HTTP server closed'));
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
