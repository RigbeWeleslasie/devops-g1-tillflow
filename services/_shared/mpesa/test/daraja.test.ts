/**
 * DarajaAdapter <-> stub-server round trip over real HTTP on an ephemeral
 * port. Proves the adapter sends, and the stub parses, the same Daraja wire
 * format — and vice versa — without touching the sandbox. The one
 * `@contract` test against the real sandbox then only has to confirm the
 * sandbox agrees with the stub.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { toMinorUnits } from '@tillflow/shared/money';
import {
  DarajaAdapter,
  createStubServer,
  MpesaTimeoutError,
  MpesaAuthError,
  STK_RESULT,
  type DarajaCredentials,
  type PendingCallback,
  type StubServer,
  type StkCallbackBody,
} from '../src/index.js';

const creds: DarajaCredentials = {
  consumerKey: 'test-key',
  consumerSecret: 'test-secret',
  passkey: 'not-a-real-passkey-see-comment-above',
  stkShortCode: '174379',
  b2c: { shortCode: '600000', initiatorName: 'testapi', securityCredential: 'not-a-real-credential' },
};

describe('DarajaAdapter against the stub-server', () => {
  let stub: StubServer;
  let baseUrl: string;
  const delivered: PendingCallback[] = [];
  const logLines: string[] = [];

  before(async () => {
    stub = createStubServer({
      timeoutHoldMs: 2_000,
      deliverIntervalMs: 20,
      deliver: async (cb) => {
        delivered.push(cb);
      },
      log: (line) => logLines.push(line),
    });
    ({ url: baseUrl } = await stub.listen(0, '127.0.0.1'));
  });

  after(async () => {
    await stub.close();
  });

  function adapter(overrides: Partial<ConstructorParameters<typeof DarajaAdapter>[0]> = {}): DarajaAdapter {
    return new DarajaAdapter({ baseUrl, credentials: creds, timeoutMs: 5_000, ...overrides });
  }

  test('STK push: OAuth then push, ack in our shape, callback auto-delivered to the URL we gave', async () => {
    const a = adapter();
    const before = delivered.length;

    const ack = await a.stkPush({
      amountMinor: toMinorUnits(25_000),
      phoneNumber: '254708374149',
      shortCode: '174379',
      accountReference: 'SALE-abc123',
      transactionDesc: 'TillFlow sale',
      callbackUrl: 'http://payments.local/callbacks/stk',
    });

    assert.equal(ack.responseCode, '0');
    assert.match(ack.checkoutRequestId, /^ws_CO_fake_/);

    // The stub flushes every 20ms; wait for delivery.
    await waitFor(() => delivered.length > before);
    const cb = delivered[delivered.length - 1]!;
    assert.equal(cb.url, 'http://payments.local/callbacks/stk');
    const body = cb.body as StkCallbackBody;
    assert.equal(body.Body.stkCallback.CheckoutRequestID, ack.checkoutRequestId);
    assert.equal(body.Body.stkCallback.ResultCode, STK_RESULT.SUCCESS);
  });

  test('the OAuth token is cached across calls', async () => {
    const a = adapter();
    const oauthCalls = () => logLines.filter((l) => l.includes('OAuth')).length;
    const before = oauthCalls();

    await a.stkQuery('ws_CO_whatever');
    await a.stkQuery('ws_CO_whatever');
    await a.stkQuery('ws_CO_whatever');

    assert.equal(oauthCalls() - before, 1, 'one token fetch for three requests');
  });

  test('STK query: in-flight is reported as pending (Daraja 500.001.1001), not as an error', async () => {
    const a = adapter();
    const ack = await a.stkPush({
      amountMinor: toMinorUnits(10_500), // KES 105: delayed_callback: customer "acts" 61s later
      phoneNumber: '254708374149',
      shortCode: '174379',
      accountReference: 'SALE-delay',
      transactionDesc: 'TillFlow sale',
      callbackUrl: 'http://payments.local/callbacks/stk',
    });

    const q = await a.stkQuery(ack.checkoutRequestId);
    assert.deepEqual(q, { status: 'pending' });
  });

  test('STK query: a completed push reports its ResultCode as a number', async () => {
    const a = adapter();
    const ack = await a.stkPush({
      amountMinor: toMinorUnits(10_100), // KES 101: cancelled
      phoneNumber: '254708374149',
      shortCode: '174379',
      accountReference: 'SALE-cancel',
      transactionDesc: 'TillFlow sale',
      callbackUrl: 'http://payments.local/callbacks/stk',
    });

    const q = await a.stkQuery(ack.checkoutRequestId);
    assert.equal(q.status, 'complete');
    if (q.status === 'complete') {
      assert.equal(q.resultCode, STK_RESULT.CANCELLED_BY_USER);
      assert.equal(typeof q.resultCode, 'number');
    }
  });

  test('B2C: ack echoes our originator id; result auto-delivered to the result URL', async () => {
    const a = adapter();
    const before = delivered.length;

    const ack = await a.b2cPayment({
      amountMinor: toMinorUnits(150_000),
      phoneNumber: '254708374149',
      originatorConversationId: 'ledger-xyz',
      remarks: 'daily commission',
      resultUrl: 'http://payments.local/callbacks/b2c',
      timeoutUrl: 'http://payments.local/callbacks/b2c-timeout',
    });

    assert.equal(ack.originatorConversationId, 'ledger-xyz');
    assert.match(ack.conversationId, /^AG_fake_/);

    await waitFor(() => delivered.length > before);
    assert.equal(delivered[delivered.length - 1]!.url, 'http://payments.local/callbacks/b2c');
  });

  test('timeout scenario: the stub holds the socket, the adapter gives up with MpesaTimeoutError', async () => {
    const a = adapter({ timeoutMs: 150 });
    await assert.rejects(
      a.stkPush({
        amountMinor: toMinorUnits(10_300), // KES 103: timeout
        phoneNumber: '254708374149',
        shortCode: '174379',
        accountReference: 'SALE-timeout',
        transactionDesc: 'TillFlow sale',
        callbackUrl: 'http://payments.local/callbacks/stk',
      }),
      MpesaTimeoutError,
    );
  });

  test('scenarioHint is forwarded as X-Fake-Scenario and honoured by the stub', async () => {
    const a = adapter({ timeoutMs: 150 });
    await assert.rejects(
      a.stkPush({
        amountMinor: toMinorUnits(30_000), // would be success by amount
        phoneNumber: '254708374149',
        shortCode: '174379',
        accountReference: 'SALE-hint',
        transactionDesc: 'TillFlow sale',
        callbackUrl: 'http://payments.local/callbacks/stk',
        scenarioHint: 'timeout',
      }),
      MpesaTimeoutError,
    );
  });

  test('a fractional-shilling amount is refused before any HTTP happens', async () => {
    const a = adapter();
    const httpBefore = logLines.length;
    await assert.rejects(
      a.stkPush({
        amountMinor: toMinorUnits(250), // KES 2.50
        phoneNumber: '254708374149',
        shortCode: '174379',
        accountReference: 'SALE-frac',
        transactionDesc: 'TillFlow sale',
        callbackUrl: 'http://payments.local/callbacks/stk',
      }),
      /whole shillings/,
    );
    assert.equal(logLines.length, httpBefore, 'the stub never saw a request');
  });

  test('a 401 triggers exactly one token refresh; a second 401 is MpesaAuthError', async () => {
    let calls = 0;
    const fetch401Twice: typeof fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/mpesa/')) {
        calls++;
        return new Response('{"errorMessage":"Invalid Access Token"}', { status: 401 });
      }
      return fetch(url, init);
    };
    const a = adapter({ fetchImpl: fetch401Twice });
    await assert.rejects(a.stkQuery('ws_CO_x'), MpesaAuthError);
    assert.equal(calls, 2, 'retried once with a fresh token, then gave up');
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
