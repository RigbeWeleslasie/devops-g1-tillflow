/**
 * Standalone sale.paid consumer process. Runs as its own long-lived process
 * (separate from the HTTP server) so a slow batch of events never blocks the
 * request path, and vice versa.
 */
import { startTelemetry } from '@tillflow/shared/otel';

startTelemetry({ serviceName: 'pos-worker' });

const { createPool } = await import('./db.js');
const { SqsEventSource } = await import('./workers/sqsEventSource.js');
const { runForever } = await import('./workers/salePaidConsumer.js');

const databaseUrl = requireEnv('DATABASE_URL');
const queueUrl = requireEnv('SALE_EVENTS_QUEUE_URL');

const db = createPool(databaseUrl);
const source = new SqsEventSource({ queueUrl });

const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => controller.abort());
}

console.log(JSON.stringify({ level: 'info', msg: 'sale.paid consumer starting', queueUrl }));

await runForever({
  db,
  source,
  signal: controller.signal,
  logger: {
    info: (obj, msg) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
    error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
  },
});

await db.end();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
