/**
 * The two HTTP boundaries. What matters is how each one reports failure:
 * POS throws (no sales means nothing to compute, fail the run), Payments
 * returns `unknown` (it owns the payout state machine, and inventing a
 * failure is how an attendant silently goes unpaid).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpPosClient, PosUnavailableError } from '../src/clients/posClient.js';
import { HttpPaymentsClient } from '../src/clients/paymentsClient.js';

const TOKEN = 'test-service-token-0123456789abcdef';
const DAY = '2026-09-14';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('HttpPosClient', () => {
  test('sends the service token and the business day, and returns the snapshot', async () => {
    let seenUrl = '';
    let seenToken: string | null = null;
    const client = new HttpPosClient({
      baseUrl: 'http://pos.test/',
      serviceToken: TOKEN,
      fetchImpl: async (url, init) => {
        seenUrl = String(url);
        seenToken = new Headers(init?.headers).get('x-service-token');
        return jsonResponse({ businessDay: DAY, windowUtc: { start: 'a', end: 'b' }, tenants: [] });
      },
    });

    const snap = await client.dailyClose(DAY);
    assert.equal(seenUrl, `http://pos.test/internal/daily-close?businessDay=${DAY}`, 'no double slash');
    assert.equal(seenToken, TOKEN);
    assert.deepEqual(snap.tenants, []);
  });

  test('a non-2xx is PosUnavailableError — the close must fail, not compute from nothing', async () => {
    for (const status of [401, 404, 500, 503]) {
      const client = new HttpPosClient({
        baseUrl: 'http://pos.test',
        serviceToken: TOKEN,
        fetchImpl: async () => new Response('nope', { status }),
      });
      await assert.rejects(client.dailyClose(DAY), PosUnavailableError, `HTTP ${status}`);
    }
  });

  test('a timeout is PosUnavailableError, not an empty day', async () => {
    const client = new HttpPosClient({
      baseUrl: 'http://pos.test',
      serviceToken: TOKEN,
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    });
    await assert.rejects(client.dailyClose(DAY), /did not answer within/);
  });

  test('a snapshot for the WRONG day is refused — closing the wrong day writes an unfixable row', async () => {
    const client = new HttpPosClient({
      baseUrl: 'http://pos.test',
      serviceToken: TOKEN,
      fetchImpl: async () =>
        jsonResponse({ businessDay: '2026-01-01', windowUtc: { start: 'a', end: 'b' }, tenants: [] }),
    });
    await assert.rejects(client.dailyClose(DAY), /when asked for/);
  });
});

describe('HttpPaymentsClient', () => {
  const ledgerId = randomUUID();

  test('201 and 200 are both "accepted" — created vs already existed', async () => {
    for (const [status, created] of [
      [201, true],
      [200, false],
    ] as const) {
      const client = new HttpPaymentsClient({
        baseUrl: 'http://payments.test',
        serviceToken: TOKEN,
        fetchImpl: async () =>
          jsonResponse(
            { payoutId: 'p1', ledgerId, status: 'PENDING', amountMinor: 5000, conversationId: 'AG_1', created },
            status,
          ),
      });
      const result = await client.requestPayout(ledgerId);
      assert.equal(result.outcome, 'accepted');
      if (result.outcome === 'accepted') assert.equal(result.payout.created, created);
    }
  });

  test('a 5xx is UNKNOWN, not rejected — Payments may have accepted it before failing', async () => {
    const client = new HttpPaymentsClient({
      baseUrl: 'http://payments.test',
      serviceToken: TOKEN,
      fetchImpl: async () => new Response('boom', { status: 502 }),
    });
    const result = await client.requestPayout(ledgerId);
    assert.equal(result.outcome, 'unknown');
  });

  test('a timeout is UNKNOWN — the row stays COMPUTED and the next run retries', async () => {
    const client = new HttpPaymentsClient({
      baseUrl: 'http://payments.test',
      serviceToken: TOKEN,
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    });
    const result = await client.requestPayout(ledgerId);
    assert.equal(result.outcome, 'unknown');
    if (result.outcome === 'unknown') assert.match(result.reason, /did not answer within/);
  });

  test('a connection failure is UNKNOWN', async () => {
    const client = new HttpPaymentsClient({
      baseUrl: 'http://payments.test',
      serviceToken: TOKEN,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const result = await client.requestPayout(ledgerId);
    assert.equal(result.outcome, 'unknown');
  });

  test('a 4xx IS rejected — a definite refusal that retrying will not fix', async () => {
    const client = new HttpPaymentsClient({
      baseUrl: 'http://payments.test',
      serviceToken: TOKEN,
      fetchImpl: async () => new Response('{"error":"ledger_not_found"}', { status: 404 }),
    });
    const result = await client.requestPayout(ledgerId);
    assert.equal(result.outcome, 'rejected');
    if (result.outcome === 'rejected') {
      assert.equal(result.status, 404);
      assert.match(result.error, /ledger_not_found/);
    }
  });

  test('sends the service token and the ledgerId in the body', async () => {
    let body: unknown;
    let token: string | null = null;
    const client = new HttpPaymentsClient({
      baseUrl: 'http://payments.test',
      serviceToken: TOKEN,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        token = new Headers(init?.headers).get('x-service-token');
        return jsonResponse({ payoutId: 'p', ledgerId, status: 'PENDING', amountMinor: 1, conversationId: null, created: true }, 201);
      },
    });
    await client.requestPayout(ledgerId);
    assert.deepEqual(body, { ledgerId });
    assert.equal(token, TOKEN);
  });
});
