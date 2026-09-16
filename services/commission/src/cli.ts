#!/usr/bin/env node
/**
 * One-off close, for the runbook and the G4 drills:
 *
 *   npm run close --workspace=@tillflow/commission -- --day 2026-09-14
 *   npm run close --workspace=@tillflow/commission           # the day just ended
 *   npm run close --workspace=@tillflow/commission -- --day 2026-09-14 --dry-run
 *
 * Running it twice is the replay drill: the second run reports
 * created=0, existing=N and requests nothing. That output IS the evidence
 * that duplicate disbursement = 0.
 *
 * --dry-run computes and prints what WOULD be written, touching neither the
 * ledger nor Payments — safe to run against prod while deciding whether to
 * re-close a day.
 */
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { HttpPosClient } from './clients/posClient.js';
import { HttpPaymentsClient } from './clients/paymentsClient.js';
import { businessDayToClose, isBusinessDay } from './services/businessDay.js';
import { computeCommission, runClose } from './services/closeService.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dryRun = process.argv.includes('--dry-run');
const day = arg('day') ?? businessDayToClose(new Date());

if (!isBusinessDay(day)) {
  process.stderr.write(`--day must be a real YYYY-MM-DD date, got "${day}"\n`);
  process.exit(1);
}

const config = loadConfig();
const db = createPool(config.databaseUrl);
const pos = new HttpPosClient({
  baseUrl: config.posBaseUrl,
  serviceToken: config.serviceToken,
  timeoutMs: config.httpTimeoutMs,
});
const payments = new HttpPaymentsClient({
  baseUrl: config.paymentsBaseUrl,
  serviceToken: config.serviceToken,
  timeoutMs: config.httpTimeoutMs,
});

try {
  if (dryRun) {
    const snapshot = await pos.dailyClose(day);
    let total = 0;
    process.stdout.write(`dry run — business day ${day} (nothing will be written)\n`);
    for (const tenant of snapshot.tenants) {
      for (const attendant of tenant.attendants) {
        const c = computeCommission(attendant);
        total += c.payoutMinor;
        process.stdout.write(
          `  tenant=${tenant.tenantId} attendant=${attendant.attendantId} ` +
            `sales=${c.saleCount} total=${c.saleTotalMinor} rate=${attendant.rateBps}bps ` +
            `commission=${c.amountMinor} payout=${c.payoutMinor} remainder=${c.remainderMinor}\n`,
        );
      }
    }
    process.stdout.write(`  would pay out ${total} minor units across ${snapshot.tenants.length} tenant(s)\n`);
  } else {
    const result = await runClose(day, {
      db,
      pos,
      payments,
      logger: {
        info: (o, m) => process.stdout.write(JSON.stringify({ level: 'info', msg: m, ...o }) + '\n'),
        warn: (o, m) => process.stdout.write(JSON.stringify({ level: 'warn', msg: m, ...o }) + '\n'),
        error: (o, m) => process.stderr.write(JSON.stringify({ level: 'error', msg: m, ...o }) + '\n'),
      },
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.ledgerRowsCreated === 0 && result.ledgerRowsExisting > 0) {
      process.stdout.write('replay: every ledger row already existed — nothing was recomputed, nothing re-paid\n');
    }
  }
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  await db.end();
}
