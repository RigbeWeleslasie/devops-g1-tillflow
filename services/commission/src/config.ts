/**
 * Runtime configuration, read once at startup. ECS injects the
 * secret-backed values from Secrets Manager via the task definition's
 * `secrets` block; local dev reads .env (see .env.example at the repo root).
 *
 * `loadConfig()` throws on a missing required value so the process dies at
 * boot rather than at 00:15 EAT when the close fires.
 */

export interface CommissionConfig {
  environment: string;
  databaseUrl: string;
  /** Shared bearer token for POS's /internal/* and Payments' /payouts. */
  serviceToken: string;
  posBaseUrl: string;
  paymentsBaseUrl: string;
  /** devops-g1-commission-payout — where the EventBridge trigger lands. */
  closeQueueUrl: string | undefined;
  awsRegion: string;
  httpTimeoutMs: number;
  /** Long-poll seconds. Matches the queue's receive_wait_time_seconds. */
  waitTimeSeconds: number;
  /** Health/readiness port. The worker has no API, but ECS still probes it. */
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CommissionConfig {
  return {
    environment: env['ENVIRONMENT'] ?? 'dev',
    databaseUrl: required(env, 'DATABASE_URL'),
    serviceToken: required(env, 'SERVICE_TOKEN'),
    posBaseUrl: required(env, 'POS_BASE_URL').replace(/\/$/, ''),
    paymentsBaseUrl: required(env, 'PAYMENTS_BASE_URL').replace(/\/$/, ''),
    closeQueueUrl: env['CLOSE_QUEUE_URL'],
    awsRegion: env['AWS_REGION'] ?? 'us-east-1',
    httpTimeoutMs: intEnv(env, 'HTTP_TIMEOUT_MS', 30_000),
    waitTimeSeconds: intEnv(env, 'SQS_WAIT_SECONDS', 20),
    port: intEnv(env, 'PORT', 8080),
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
