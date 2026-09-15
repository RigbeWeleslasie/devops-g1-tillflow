/**
 * Stub-server — a fake Daraja over HTTP (ADR 0005: "a tiny HTTP stub
 * service" for k6).
 *
 * Speaks Daraja's exact wire format (wire.ts) and is backed by FakeAdapter,
 * so under k6 the Payments service runs with MPESA_ADAPTER=daraja pointed
 * here — meaning the real DarajaAdapter HTTP path (OAuth, timeouts, callback
 * delivery over the network) is what gets load-tested, not an in-process
 * shortcut. The round-trip test in test/daraja.test.ts proves adapter and
 * stub agree on the wire format without touching the sandbox.
 *
 * Differences from the fake used in unit tests:
 *   - Callbacks auto-deliver on a timer (unit tests pull them by hand).
 *   - A `timeout` scenario holds the socket open past the client's timeout
 *     and then drops it — the client experiences a real network timeout.
 *
 * Dependency-free (node:http) so it can run as a throwaway ECS task or a
 * sidecar container without pulling in the service stack.
 */
import http from 'node:http';
import { FakeAdapter, type PendingCallback } from './fake.js';
import { MpesaTimeoutError } from './adapter.js';
import { toMinorUnits } from '@tillflow/shared/money';
import {
  DARAJA_ERROR,
  DARAJA_PATH,
  type B2CWireRequest,
  type B2CWireResponse,
  type DarajaErrorResponse,
  type OAuthResponse,
  type StkPushWireRequest,
  type StkPushWireResponse,
  type StkQueryWireRequest,
  type StkQueryWireResponse,
} from './wire.js';

export interface StubServerOptions {
  fake?: FakeAdapter;
  /** How often queued callbacks are flushed. */
  deliverIntervalMs?: number;
  /** How long a `timeout` scenario holds the socket before dropping it. Must exceed the client's timeout. */
  timeoutHoldMs?: number;
  /** Delivers a callback to the Payments service. Defaults to fetch. */
  deliver?: (cb: PendingCallback) => Promise<void>;
  /** Called for each request; defaults to a one-line stdout log. Pass a no-op to silence. */
  log?: (line: string) => void;
}

export interface StubServer {
  listen(port?: number, host?: string): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
  readonly fake: FakeAdapter;
}

const defaultDeliver = async (cb: PendingCallback): Promise<void> => {
  const res = await fetch(cb.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cb.body),
  });
  if (!res.ok) {
    throw new Error(`callback to ${cb.url} returned HTTP ${res.status}`);
  }
};

export function createStubServer(opts: StubServerOptions = {}): StubServer {
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const timeoutHoldMs = opts.timeoutHoldMs ?? 30_000;
  const deliverIntervalMs = opts.deliverIntervalMs ?? 200;
  const deliver = opts.deliver ?? defaultDeliver;

  const fake =
    opts.fake ??
    new FakeAdapter({
      deliver,
      seed: Math.floor(Date.now() / 1000) * 1000, // unique per process, still monotonic within it
    });

  let timer: NodeJS.Timeout | undefined;
  const pendingSockets = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log(`stub: ${req.method} ${req.url} -> 500 ${err instanceof Error ? err.message : String(err)}`);
      sendJson(res, 500, {
        requestId: 'stub',
        errorCode: '500.003.02',
        errorMessage: err instanceof Error ? err.message : 'internal error',
      } satisfies DarajaErrorResponse);
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://stub');
    const path = url.pathname;

    if (path === '/health') {
      return sendJson(res, 200, { status: 'ok', service: 'mpesa-stub', pending: fake.peekPending().length });
    }

    if (req.method === 'GET' && path === DARAJA_PATH.OAUTH) {
      if (!req.headers.authorization?.startsWith('Basic ')) {
        return sendJson(res, 400, {
          requestId: 'stub',
          errorCode: '400.008.01',
          errorMessage: 'Invalid Authentication passed',
        } satisfies DarajaErrorResponse);
      }
      const body: OAuthResponse = { access_token: `stub-token-${Date.now()}`, expires_in: '3599' };
      log(`stub: OAuth -> 200`);
      return sendJson(res, 200, body);
    }

    if (req.method !== 'POST') {
      return sendJson(res, 404, { requestId: 'stub', errorCode: '404.001.01', errorMessage: 'Resource not found' });
    }
    if (!req.headers.authorization?.startsWith('Bearer ')) {
      return sendJson(res, 401, { requestId: 'stub', errorCode: '401.001.01', errorMessage: 'Invalid Access Token' });
    }

    const scenarioHint = headerString(req.headers['x-fake-scenario']);
    const body = await readJson(req);

    if (path === DARAJA_PATH.STK_PUSH) {
      const w = body as StkPushWireRequest;
      try {
        const ack = await fake.stkPush({
          amountMinor: toMinorUnits(Math.round(w.Amount * 100)),
          phoneNumber: w.PhoneNumber,
          shortCode: w.PartyB,
          accountReference: w.AccountReference,
          transactionDesc: w.TransactionDesc,
          callbackUrl: w.CallBackURL,
          ...(scenarioHint ? { scenarioHint } : {}),
        });
        log(`stub: STK push KES ${w.Amount} -> ${ack.checkoutRequestId}`);
        const out: StkPushWireResponse = {
          MerchantRequestID: ack.merchantRequestId,
          CheckoutRequestID: ack.checkoutRequestId,
          ResponseCode: ack.responseCode,
          ResponseDescription: ack.responseDescription,
          CustomerMessage: ack.customerMessage,
        };
        return sendJson(res, 200, out);
      } catch (err) {
        if (err instanceof MpesaTimeoutError) return holdThenDrop(res, `STK push KES ${w.Amount}`);
        throw err;
      }
    }

    if (path === DARAJA_PATH.STK_QUERY) {
      const w = body as StkQueryWireRequest;
      const q = await fake.stkQuery(w.CheckoutRequestID);
      if (q.status === 'pending') {
        log(`stub: STK query ${w.CheckoutRequestID} -> in progress`);
        return sendJson(res, 500, {
          requestId: 'stub',
          errorCode: DARAJA_ERROR.TRANSACTION_IN_PROGRESS,
          errorMessage: 'The transaction is being processed',
        } satisfies DarajaErrorResponse);
      }
      log(`stub: STK query ${w.CheckoutRequestID} -> ${q.resultCode}`);
      const out: StkQueryWireResponse = {
        ResponseCode: '0',
        ResponseDescription: 'The service request has been accepted successsfully',
        MerchantRequestID: '',
        CheckoutRequestID: w.CheckoutRequestID,
        ResultCode: String(q.resultCode),
        ResultDesc: q.resultDesc,
      };
      return sendJson(res, 200, out);
    }

    if (path === DARAJA_PATH.B2C) {
      const w = body as B2CWireRequest;
      try {
        const ack = await fake.b2cPayment({
          amountMinor: toMinorUnits(Math.round(w.Amount * 100)),
          phoneNumber: w.PartyB,
          originatorConversationId: w.OriginatorConversationID,
          remarks: w.Remarks,
          resultUrl: w.ResultURL,
          timeoutUrl: w.QueueTimeOutURL,
          ...(w.Occasion !== undefined ? { occasion: w.Occasion } : {}),
          ...(scenarioHint ? { scenarioHint } : {}),
        });
        log(`stub: B2C KES ${w.Amount} -> ${ack.conversationId}`);
        const out: B2CWireResponse = {
          ConversationID: ack.conversationId,
          OriginatorConversationID: ack.originatorConversationId,
          ResponseCode: ack.responseCode,
          ResponseDescription: ack.responseDescription,
        };
        return sendJson(res, 200, out);
      } catch (err) {
        if (err instanceof MpesaTimeoutError) return holdThenDrop(res, `B2C KES ${w.Amount}`);
        throw err;
      }
    }

    return sendJson(res, 404, { requestId: 'stub', errorCode: '404.001.01', errorMessage: 'Resource not found' });
  }

  /** Simulates a provider that received the request but never answers. */
  function holdThenDrop(res: http.ServerResponse, what: string): void {
    log(`stub: ${what} -> holding socket ${timeoutHoldMs}ms (timeout scenario)`);
    pendingSockets.add(res);
    const t = setTimeout(() => {
      pendingSockets.delete(res);
      res.destroy();
    }, timeoutHoldMs);
    res.on('close', () => {
      clearTimeout(t);
      pendingSockets.delete(res);
    });
  }

  async function flush(): Promise<void> {
    try {
      const n = await fake.deliverPending();
      if (n > 0) log(`stub: delivered ${n} callback(s)`);
    } catch (err) {
      log(`stub: callback delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    fake,
    listen(port = 0, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const addr = server.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : port;
          timer = setInterval(() => void flush(), deliverIntervalMs);
          timer.unref();
          resolve({ url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`, port: actualPort });
        });
      });
    },
    close() {
      if (timer) clearInterval(timer);
      for (const s of pendingSockets) s.destroy();
      pendingSockets.clear();
      return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function headerString(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Run directly: `node dist/stub-server.js`, or `npm run stub` (tsx on the .ts). PORT defaults to 9090.
if (process.argv[1] && /stub-server\.[cm]?[jt]s$/.test(process.argv[1])) {
  const stub = createStubServer();
  const port = Number(process.env['PORT'] ?? 9090);
  stub
    .listen(port)
    .then(({ url }) => process.stdout.write(`mpesa stub-server listening on ${url}\n`))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => void stub.close().then(() => process.exit(0)));
  }
}
