import { startTelemetry } from '@tillflow/shared/otel';

startTelemetry({ serviceName: 'web' });

const { buildApp } = await import('./app.js');

const port = Number(process.env['PORT'] ?? 8080);
const posBaseUrl = requireEnv('POS_BASE_URL');

const app = await buildApp({ posBaseUrl });

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
