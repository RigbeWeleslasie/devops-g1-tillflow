import { startTelemetry } from '@tillflow/shared/otel';

// Must run before anything it's meant to instrument is imported.
startTelemetry({ serviceName: 'pos' });

const { createPool } = await import('./db.js');
const { HttpPaymentsClient } = await import('./services/paymentsClient.js');
const { buildApp } = await import('./app.js');

const port = Number(process.env['PORT'] ?? 8080);
const databaseUrl = requireEnv('DATABASE_URL');
const jwtSecret = requireEnv('JWT_SECRET');
const paymentsBaseUrl = requireEnv('PAYMENTS_BASE_URL');
const serviceToken = requireEnv('SERVICE_TOKEN');

const db = createPool(databaseUrl);
const paymentsClient = new HttpPaymentsClient({ baseUrl: paymentsBaseUrl, serviceToken });

const app = await buildApp({ db, paymentsClient, jwtSecret, serviceToken });

app.addHook('onClose', async () => {
  await db.end();
});

try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
