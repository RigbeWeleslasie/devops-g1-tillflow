import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { startFakePos } from './fakePos.js';

function getCookie(res: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first?.split(';')[0];
}

/**
 * Every test spins up two real listening servers (the web app + fakePos).
 * `t.after()` guarantees both close even if an assertion throws mid-test —
 * without it, a failing assertion skips the cleanup lines below it and
 * leaves an open TCP listener behind, which keeps the whole test *process*
 * alive (not just the test) long after the run should have finished. That
 * happened once while writing this suite: a real bug (see posClient.ts's
 * content-type fix) caused an assertion failure that hung `node --test`
 * for the rest of its timeout instead of reporting a clean failure.
 */
async function withApps(
  t: { after: (fn: () => Promise<void>) => void },
): Promise<{ app: FastifyInstance; fakePos: FastifyInstance; baseUrl: string }> {
  const { app: fakePos, baseUrl } = await startFakePos();
  const app = await buildApp({ posBaseUrl: baseUrl, logger: false });
  t.after(async () => {
    await app.close();
    await fakePos.close();
  });
  return { app, fakePos, baseUrl };
}

test('GET / redirects to /login when there is no session cookie', async (t) => {
  const { app } = await withApps(t);
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/login');
});

test('tenant bootstrap -> owner dashboard end to end through the real shell routes', async (t) => {
  const { app } = await withApps(t);

  const setupRes = await app.inject({
    method: 'POST',
    url: '/setup',
    payload: {
      name: 'Test Shop',
      tillNumber: '123456',
      ownerExternalAuthId: 'owner-1',
      ownerDisplayName: 'Owner One',
    },
  });
  assert.equal(setupRes.statusCode, 302);
  assert.equal(setupRes.headers.location, '/owner');
  const cookie = getCookie(setupRes);
  assert.ok(cookie, 'a session cookie must be set');

  const ownerRes = await app.inject({
    method: 'GET',
    url: '/owner',
    headers: { cookie },
  });
  assert.equal(ownerRes.statusCode, 200);
  assert.match(ownerRes.body, /Test Shop/);
});

test('sale creation -> pay flow renders the sale status page', async (t) => {
  const { app } = await withApps(t);

  const setupRes = await app.inject({
    method: 'POST',
    url: '/setup',
    payload: {
      name: 'Test Shop',
      tillNumber: '123456',
      ownerExternalAuthId: 'owner-1',
      ownerDisplayName: 'Owner One',
    },
  });
  const cookie = getCookie(setupRes);

  const createRes = await app.inject({
    method: 'POST',
    url: '/sell',
    headers: { cookie },
    payload: { attendantId: 'att-1', productId: 'prod-1', quantity: '2' },
  });
  assert.equal(createRes.statusCode, 302);
  assert.match(createRes.headers.location as string, /^\/sell\//);

  const saleRes = await app.inject({ method: 'GET', url: createRes.headers.location as string, headers: { cookie } });
  assert.equal(saleRes.statusCode, 200);
  assert.match(saleRes.body, /UNPAID/);

  const payRes = await app.inject({
    method: 'POST',
    url: `${createRes.headers.location}/pay`,
    headers: { cookie },
    payload: { customerMsisdn: '254708374149' },
  });
  assert.equal(payRes.statusCode, 302);
});

test('unauthenticated access to /owner redirects to /login rather than leaking data', async (t) => {
  const { app } = await withApps(t);
  const res = await app.inject({ method: 'GET', url: '/owner' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/login');
});
