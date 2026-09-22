/**
 * A local stand-in for the deployed stack, so the drill scripts can be
 * VALIDATED before anyone runs them against AWS.
 *
 * Real: the Payments HTTP surface, the DarajaAdapter's real HTTP path (OAuth,
 * timeouts, callback delivery over the network), and the stub-server speaking
 * Daraja's wire format. Faked: the database (pg-mem, loaded with the real
 * migrations) and Daraja itself (the stub). That is the same faking boundary
 * as tests/integration/, one layer further out — the drills go through
 * sockets, not `inject()`.
 *
 * It exists because a drill script that has never been run is a description,
 * not a tool. Both scripts below were run against this before being trusted.
 *
 *   npx tsx evidence/payments-integrity/drills/local-stack.mts
 *   # prints the BASE_URL / SERVICE_TOKEN / PAYMENTS_PREFIX to export, then waits
 */
// Through the PACKAGE, not the source path. Payments imports @tillflow/mpesa
// too, and error classification is `instanceof MpesaTimeoutError` — importing
// the adapter from src/ here while payments gets it from dist/ makes two
// copies of that class, instanceof fails, and a timeout 500s instead of
// staying PENDING. Found the first time this stack was run; the deployed
// service has one copy and does not have this problem.
import { createStubServer, DarajaAdapter } from '@tillflow/mpesa';
import { buildApp } from '../../../services/payments/src/app.js';
import { createTestDb } from '../../../services/payments/test/testDb.js';

const SERVICE_TOKEN = 'local-drill-service-token-0123456789';
const PAYMENTS_PORT = Number(process.env['PAYMENTS_PORT'] ?? 18080);
const STUB_PORT = Number(process.env['STUB_PORT'] ?? 19090);
const ADAPTER_TIMEOUT_MS = 4_000;

const stub = createStubServer({
  deliverIntervalMs: 250,
  // The stub must hold the socket LONGER than the adapter waits, or the
  // adapter never times out and 2.1 cannot be forced.
  timeoutHoldMs: ADAPTER_TIMEOUT_MS + 5_000,
  log: (l) => process.stdout.write(`  [stub] ${l}\n`),
});
const { url: stubUrl } = await stub.listen(STUB_PORT, '127.0.0.1');

const adapter = new DarajaAdapter({
  baseUrl: stubUrl,
  timeoutMs: ADAPTER_TIMEOUT_MS,
  credentials: {
    consumerKey: 'placeholder',
    consumerSecret: 'placeholder',
    passkey: 'placeholder',
    stkShortCode: '174379',
    b2c: { shortCode: '600000', initiatorName: 'testapi', securityCredential: 'placeholder' },
  },
});

const { db } = createTestDb();
const app = await buildApp({
  db,
  adapter,
  serviceToken: SERVICE_TOKEN,
  // The stub delivers callbacks here, over a real socket.
  callbackBaseUrl: `http://127.0.0.1:${PAYMENTS_PORT}`,
  reconcileAfterMs: 0,
  reconcileMaxAttempts: 3,
  logger: false,
});
await app.listen({ port: PAYMENTS_PORT, host: '127.0.0.1' });

process.stdout.write(`
local drill stack up
  payments  http://127.0.0.1:${PAYMENTS_PORT}   (pg-mem, real migrations)
  stub      ${stubUrl}   (DarajaAdapter -> stub over HTTP, ${ADAPTER_TIMEOUT_MS}ms timeout)

export BASE_URL=http://127.0.0.1:${PAYMENTS_PORT}
export PAYMENTS_PREFIX=
export SERVICE_TOKEN=${SERVICE_TOKEN}

`);

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    void Promise.all([app.close(), stub.close()]).then(() => process.exit(0));
  });
}
