import { startTelemetry } from '@tillflow/shared/otel';

// Must run before anything it instruments (Fastify, pg, http) is imported.
startTelemetry({ serviceName: 'payments' });

const { loadConfig } = await import('./config.js');
const { createPool } = await import('./db.js');
const { buildApp } = await import('./app.js');
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
});

if (adapter instanceof FakeAdapter) {
  fakeDeliveryTimer = setInterval(() => {
    adapter.deliverPending().catch((err: unknown) => app.log.warn({ err }, 'fake callback delivery failed'));
  }, 500);
  fakeDeliveryTimer.unref();
}

app.addHook('onClose', async () => {
  if (fakeDeliveryTimer) clearInterval(fakeDeliveryTimer);
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
  app.log.info({ adapter: config.mpesaAdapter, environment: config.environment }, 'payments listening');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
