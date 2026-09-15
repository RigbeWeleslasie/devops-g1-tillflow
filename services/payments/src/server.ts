import { startTelemetry } from '@tillflow/shared/otel';

// Must run before anything it instruments (Fastify, pg, http) is imported.
startTelemetry({ serviceName: 'payments' });

const { loadConfig } = await import('./config.js');
const { createPool, LOCK_KEY, withAdvisoryLock } = await import('./db.js');
const { buildApp } = await import('./app.js');
const { startReconciler } = await import('./services/reconcileService.js');
const { relayOnce } = await import('./services/outbox.js');
const { SqsEventPublisher, UnconfiguredPublisher } = await import('./services/sqsPublisher.js');
const { FakeAdapter, DarajaAdapter } = await import('@tillflow/mpesa');

const config = loadConfig();
const db = createPool(config.databaseUrl);

// ADR 0005: `prod` runs the real adapter; everything else the deterministic
// fake. In local dev the fake delivers callbacks to this very service over
// HTTP on a timer, so the whole callback path runs without AWS.
let fakeDeliveryTimer: NodeJS.Timeout | undefined;
const adapter =
  config.mpesaAdapter === 'daraja'
    ? new DarajaAdapter({
        baseUrl: config.daraja.baseUrl,
        timeoutMs: config.daraja.timeoutMs,
        credentials: {
          consumerKey: config.daraja.consumerKey,
          consumerSecret: config.daraja.consumerSecret,
          passkey: config.daraja.passkey,
          stkShortCode: config.daraja.stkShortCode,
          b2c: {
            shortCode: config.daraja.b2cShortCode,
            initiatorName: config.daraja.b2cInitiatorName,
            securityCredential: config.daraja.b2cSecurityCredential,
          },
        },
      })
    : new FakeAdapter({
        deliver: async (cb) => {
          const res = await fetch(cb.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(cb.body),
          });
          if (!res.ok) throw new Error(`callback ${cb.url} -> HTTP ${res.status}`);
        },
      });

const app = await buildApp({
  db,
  adapter,
  serviceToken: config.serviceToken,
  callbackBaseUrl: config.callbackBaseUrl,
  reconcileAfterMs: config.reconcileAfterMs,
  reconcileMaxAttempts: config.reconcileMaxAttempts,
});

if (adapter instanceof FakeAdapter) {
  fakeDeliveryTimer = setInterval(() => {
    adapter.deliverPending().catch((err: unknown) => app.log.warn({ err }, 'fake callback delivery failed'));
  }, 500);
  fakeDeliveryTimer.unref();
}

// Outbox relay: publishes sale.paid to SQS. Under an advisory lock so that
// with several tasks only one relays at a time — duplicates would be
// harmless (POS is idempotent on saleId) but wasteful.
const publisher = config.saleEventsQueueUrl
  ? new SqsEventPublisher({ queueUrl: config.saleEventsQueueUrl, region: config.awsRegion })
  : new UnconfiguredPublisher();
if (!config.saleEventsQueueUrl) {
  app.log.warn('SALE_EVENTS_QUEUE_URL is not set; sale.paid events will accumulate in the outbox');
}

const outboxTimer = setInterval(() => {
  void withAdvisoryLock(db, LOCK_KEY.OUTBOX_RELAY, async () => relayOnce({ db, publisher }))
    .then((result) => {
      if (result && (result.published > 0 || result.failed > 0)) {
        app.log.info({ ...result }, 'outbox relay');
      }
    })
    .catch((err: unknown) => app.log.warn({ err: String(err) }, 'outbox relay tick failed'));
}, config.outboxIntervalMs);
outboxTimer.unref();

const stopReconciler = startReconciler({
  db,
  adapter,
  afterMs: config.reconcileAfterMs,
  maxAttempts: config.reconcileMaxAttempts,
  intervalMs: config.reconcileIntervalMs,
  logger: app.log,
});

app.addHook('onClose', async () => {
  if (fakeDeliveryTimer) clearInterval(fakeDeliveryTimer);
  clearInterval(outboxTimer);
  stopReconciler();
  await db.end();
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(
    { adapter: config.mpesaAdapter, environment: config.environment, sha: process.env['COMMIT_SHA'] },
    'payments listening',
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
