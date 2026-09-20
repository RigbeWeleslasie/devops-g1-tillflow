/**
 * Runtime configuration, read once from the environment. ECS injects the
 * secret-backed values (Daraja credentials, service token, DB URL) from
 * Secrets Manager as env vars via the task definition's `secrets` block; in
 * local dev they come from .env (see .env.example at the repo root).
 *
 * Nothing here is logged. `loadConfig()` throws on a missing required value
 * so the process fails at startup, not on the first request.
 */

export interface PaymentsConfig {
  port: number;
  environment: string;
  databaseUrl: string;
  serviceToken: string;
  /** Public base URL Daraja will POST callbacks to, e.g. https://<api-gw>/payments. */
  callbackBaseUrl: string;
  mpesaAdapter: 'fake' | 'daraja';
  daraja: {
    baseUrl: string;
    consumerKey: string;
    consumerSecret: string;
    passkey: string;
    stkShortCode: string;
    b2cShortCode: string;
    b2cInitiatorName: string;
    b2cSecurityCredential: string;
    timeoutMs: number;
  };
  /** Ask stkQuery about PENDING charges older than this. */
  reconcileAfterMs: number;
  reconcileIntervalMs: number;
  /** Past this many queries, a still-PENDING charge is alerted on, never auto-failed. */
  reconcileMaxAttempts: number;
  /**
   * Confirm a success callback against Daraja before any PAID transition.
   * On unless CONFIRM_CALLBACKS=false -- an explicit opt-OUT, because the
   * failure mode of getting this wrong is paying out on a forged callback.
   */
  confirmCallbacks: boolean;
  outboxIntervalMs: number;
  saleEventsQueueUrl: string | undefined;
  awsRegion: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PaymentsConfig {
  const mpesaAdapter = env['MPESA_ADAPTER'] === 'daraja' ? 'daraja' : 'fake';
  const environment = env['ENVIRONMENT'] ?? 'dev';

  if (environment === 'prod' && mpesaAdapter !== 'daraja') {
    throw new Error('MPESA_ADAPTER must be "daraja" in prod (ADR 0005)');
  }

  const daraja = {
    baseUrl: env['DARAJA_BASE_URL'] ?? 'https://sandbox.safaricom.co.ke',
    consumerKey: env['DARAJA_CONSUMER_KEY'] ?? '',
    consumerSecret: env['DARAJA_CONSUMER_SECRET'] ?? '',
    passkey: env['DARAJA_PASSKEY'] ?? '',
    stkShortCode: env['DARAJA_SHORTCODE'] ?? '',
    b2cShortCode: env['DARAJA_B2C_SHORTCODE'] ?? '',
    b2cInitiatorName: env['DARAJA_B2C_INITIATOR'] ?? '',
    b2cSecurityCredential: env['DARAJA_B2C_SECURITY_CREDENTIAL'] ?? '',
    timeoutMs: intEnv(env, 'DARAJA_TIMEOUT_MS', 10_000),
  };

  if (mpesaAdapter === 'daraja') {
    for (const [k, v] of Object.entries(daraja)) {
      if (v === '') throw new Error(`MPESA_ADAPTER=daraja requires DARAJA_* to be set (missing ${k})`);
    }
  }

  return {
    port: intEnv(env, 'PORT', 8080),
    environment,
    databaseUrl: required(env, 'DATABASE_URL'),
    serviceToken: required(env, 'SERVICE_TOKEN'),
    callbackBaseUrl: required(env, 'MPESA_CALLBACK_BASE_URL').replace(/\/$/, ''),
    mpesaAdapter,
    daraja,
    reconcileAfterMs: intEnv(env, 'RECONCILE_AFTER_MS', 2 * 60_000),
    reconcileIntervalMs: intEnv(env, 'RECONCILE_INTERVAL_MS', 5 * 60_000),
    reconcileMaxAttempts: intEnv(env, 'RECONCILE_MAX_ATTEMPTS', 12),
    confirmCallbacks: env['CONFIRM_CALLBACKS'] !== 'false',
    outboxIntervalMs: intEnv(env, 'OUTBOX_INTERVAL_MS', 1_000),
    saleEventsQueueUrl: env['SALE_EVENTS_QUEUE_URL'],
    awsRegion: env['AWS_REGION'] ?? 'us-east-1',
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}
