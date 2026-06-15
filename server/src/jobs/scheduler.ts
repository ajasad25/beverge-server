import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../lib/env';
import { sweepFailedOrdersForRetry } from '../services/order-retry.service';
import { recomputeAlerts } from '../services/alerts.service';
import { recomputeRetailerHealth } from '../services/retailer-health.service';
import { pruneRefreshTokens } from '../services/auth.service';

export type ScheduledJob = {
  name: string;
  cronExpr: string;
  task: ScheduledTask;
};

// Wraps a job body in error handling so a thrown exception doesn't kill the
// scheduler. Each tick logs its outcome to stdout for Railway log capture.
function run(name: string, fn: () => Promise<unknown>): Promise<void> {
  return fn()
    .then((result) => {
      console.log(`[cron:${name}] OK`, result ?? '');
    })
    .catch((err) => {
      console.error(`[cron:${name}] FAILED`, err);
    });
}

// node-cron expression "0 0 * * *" = every day at 00:00 in CRON_TIMEZONE
// (Asia/Karachi by default — the canonical business-day boundary).
// Per SRS D10 / §16 risk register the midnight cron is load-bearing — if it
// fails silently, FAILED orders never re-enter the queue. The wrapper above
// guarantees one log line per tick so a missing log signals a sick scheduler.
const MIDNIGHT = '0 0 * * *';
// §9.6 alerts are time-sensitive (salesman-idle-by-midday, EOD-not-
// submitted) but don't need minute precision; hourly keeps the badge fresh
// without load. recomputeAlerts is idempotent per day so re-runs are safe.
const HOURLY = '0 * * * *';

let started = false;
const jobs: ScheduledJob[] = [];

export function startScheduler(): ScheduledJob[] {
  if (started) return jobs;
  started = true;

  jobs.push({
    name: 'failed-orders-retry-sweep',
    cronExpr: MIDNIGHT,
    task: cron.schedule(MIDNIGHT, () => run('failed-orders-retry-sweep', sweepFailedOrdersForRetry), {
      timezone: env.CRON_TIMEZONE,
    }),
  });

  jobs.push({
    name: 'alerts-recompute-sweep',
    cronExpr: HOURLY,
    task: cron.schedule(HOURLY, () => run('alerts-recompute-sweep', recomputeAlerts), {
      timezone: env.CRON_TIMEZONE,
    }),
  });

  jobs.push({
    name: 'retailer-health-recalc',
    cronExpr: MIDNIGHT,
    task: cron.schedule(MIDNIGHT, () => run('retailer-health-recalc', recomputeRetailerHealth), {
      timezone: env.CRON_TIMEZONE,
    }),
  });

  // AUTH-4: prune expired / long-revoked refresh-token rows so the table doesn't
  // grow unbounded (one row per login + per silent refresh).
  jobs.push({
    name: 'refresh-token-prune',
    cronExpr: MIDNIGHT,
    task: cron.schedule(MIDNIGHT, () => run('refresh-token-prune', () => pruneRefreshTokens()), {
      timezone: env.CRON_TIMEZONE,
    }),
  });

  console.log(`[scheduler] started ${jobs.length} job(s):`, jobs.map((j) => `${j.name} @ ${j.cronExpr}`).join(', '));
  return jobs;
}

export function stopScheduler(): void {
  for (const j of jobs) j.task.stop();
  jobs.length = 0;
  started = false;
}

// Exported for testing and for the optional admin "run now" endpoint.
export async function runFailedOrdersRetrySweepNow(): Promise<void> {
  await run('failed-orders-retry-sweep', sweepFailedOrdersForRetry);
}
