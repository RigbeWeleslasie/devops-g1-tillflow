import { startTelemetry } from '@tillflow/shared/otel';

// Must run before anything it instruments (pg, http) is imported.
startTelemetry({ serviceName: 'commission' });

const { loadConfig } = await import('./config.js');
const { createPool } = await import('./db.js');
const { HttpPosClient } = await import('./clients/posClient.js');
const { HttpPaymentsClient } = await import('./clients/paymentsClient.js');
const { SqsTriggerSource } = await import('./workers/sqsTriggerSource.js');
const { runForever } = await import('./workers/closeWorker.js');
const { createHealthServer } = await import('./health.js');

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

if (!config.closeQueueUrl) {
  process.stderr.write('CLOSE_QUEUE_URL is required for the worker; use `npm run close` for a one-off close\n');
  process.exit(1);
}

const source = new SqsTriggerSource({
  queueUrl: config.closeQueueUrl,
  region: config.awsRegion,
  waitTimeSeconds: config.waitTimeSeconds,
  // A close must finish before the trigger becomes visible again, or two
  // tasks would run it concurrently. They would still converge (I4), but
  // there is no reason to make them race.
  visibilityTimeoutSeconds: 300,
});

// The worker serves no API, but ECS still probes /health and /ready, and
// /version is the artifact-identity evidence the brief asks for.
const health = createHealthServer({ db, port: config.port });
await health.listen();

const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    process.stdout.write(JSON.stringify({ level: 'info', signal, msg: 'shutting down' }) + '\n');
    controller.abort();
    void health.close().then(() => db.end()).then(() => process.exit(0));
  });
}

const logger = {
  info: (o: object, m?: string) => log('info', o, m),
  warn: (o: object, m?: string) => log('warn', o, m),
  error: (o: object, m?: string) => log('error', o, m),
};

function log(level: string, o: object, msg?: string): void {
  process.stdout.write(JSON.stringify({ level, time: new Date().toISOString(), msg, ...o }) + '\n');
}

logger.info(
  { environment: config.environment, queue: config.closeQueueUrl, sha: process.env['COMMIT_SHA'] },
  'commission worker started',
);

await runForever({
  db,
  pos,
  payments,
  source,
  logger,
  useAdvisoryLock: true,
  signal: controller.signal,
});
