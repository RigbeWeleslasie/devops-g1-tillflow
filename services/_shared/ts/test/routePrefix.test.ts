/**
 * The prefix strip is what stands between the edge and every route in every
 * service, so these tests cover the rule itself and then prove it through a
 * real Fastify instance — a correct regex applied at the wrong point in the
 * request lifecycle still 404s in production, which is exactly what the first
 * draft of this did (an onRequest hook runs AFTER routing).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { routePrefixRewrite, stripRoutePrefix } from '../src/routePrefix.js';

test('strips the service prefix, with or without /api', () => {
  assert.equal(stripRoutePrefix('/pos/sales', 'pos'), '/sales');
  assert.equal(stripRoutePrefix('/api/pos/sales', 'pos'), '/sales');
  assert.equal(stripRoutePrefix('/payments/charges', 'payments'), '/charges');
  assert.equal(stripRoutePrefix('/api/payments/charges', 'payments'), '/charges');
});

test('a bare prefix becomes the root, never an empty string', () => {
  // '' is not a valid path and would make Fastify match nothing.
  assert.equal(stripRoutePrefix('/pos', 'pos'), '/');
  assert.equal(stripRoutePrefix('/api/pos', 'pos'), '/');
});

test('an already-unprefixed path is left alone', () => {
  // The ALB health check and the container HEALTHCHECK both call /ready
  // directly on the task, with no prefix. They must keep working.
  assert.equal(stripRoutePrefix('/ready', 'pos'), '/ready');
  assert.equal(stripRoutePrefix('/health', 'pos'), '/health');
  assert.equal(stripRoutePrefix('/', 'pos'), '/');
});

test('the prefix must be a whole path segment', () => {
  // The (?=/|$) lookahead: without it, /position would become /ition.
  assert.equal(stripRoutePrefix('/position/x', 'pos'), '/position/x');
  assert.equal(stripRoutePrefix('/posters', 'pos'), '/posters');
  assert.equal(stripRoutePrefix('/api/position', 'pos'), '/api/position');
});

test('only the first occurrence is stripped', () => {
  // A sale id or query value that happens to contain the service name must
  // survive: strip once at the front, never globally.
  assert.equal(stripRoutePrefix('/pos/sales/pos', 'pos'), '/sales/pos');
  assert.equal(stripRoutePrefix('/pos/pos', 'pos'), '/pos');
});

test('another service prefix is not stripped', () => {
  // payments must not eat a pos path -- that would mask a real mis-route.
  assert.equal(stripRoutePrefix('/payments/charges', 'pos'), '/payments/charges');
});

test('routes match through the rewrite, prefixed and unprefixed', async () => {
  const app = Fastify({ rewriteUrl: routePrefixRewrite('pos') });
  app.get('/ready', async () => ({ status: 'ready' }));
  app.get('/sales/:id', async (req) => ({ id: (req.params as { id: string }).id }));

  for (const url of ['/ready', '/pos/ready', '/api/pos/ready']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, `${url} -> ${res.statusCode}`);
    assert.deepEqual(res.json(), { status: 'ready' });
  }

  const sale = await app.inject({ method: 'GET', url: '/pos/sales/abc123' });
  assert.equal(sale.statusCode, 200);
  assert.deepEqual(sale.json(), { id: 'abc123' });

  await app.close();
});

test('the query string survives the rewrite', async () => {
  const app = Fastify({ rewriteUrl: routePrefixRewrite('pos') });
  app.get('/sales', async (req) => ({ q: (req.query as { day?: string }).day ?? null }));

  const res = await app.inject({ method: 'GET', url: '/pos/sales?day=2026-09-19' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { q: '2026-09-19' });

  await app.close();
});

test('the rewrite applies to routes registered by plugins', async () => {
  // Every real route arrives via app.register(). rewriteUrl runs as the
  // request enters the server, before routing and before any encapsulation
  // context exists, so plugin-registered routes get the stripped path too.
  const app = Fastify({ rewriteUrl: routePrefixRewrite('pos') });
  await app.register(async (child) => {
    child.get('/internal/daily-close', async () => ({ ok: true }));
  });

  const res = await app.inject({ method: 'GET', url: '/pos/internal/daily-close' });
  assert.equal(res.statusCode, 200, 'sibling-plugin route did not get the stripped path');

  await app.close();
});

test('a POST body is not disturbed by the rewrite', async () => {
  const app = Fastify({ rewriteUrl: routePrefixRewrite('payments') });
  app.post('/callbacks/stk', async (req) => ({ echoed: req.body }));

  const res = await app.inject({
    method: 'POST',
    url: '/payments/callbacks/stk',
    payload: { CheckoutRequestID: 'ws_CO_1', ResultCode: 0 },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { echoed: { CheckoutRequestID: 'ws_CO_1', ResultCode: 0 } });

  await app.close();
});
