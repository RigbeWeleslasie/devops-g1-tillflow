// Shared config, read once. All four scenarios import from here so a
// threshold or endpoint change happens in one place.

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');

// POS is mounted at /api/pos/* (and bare /pos/*) behind the real API
// Gateway -> ALB edge (infra/edge.tf); against a bare local server (no
// edge in front) POS_PREFIX can be set to '' instead.
//
// This default assumes the edge passes the full path through unrewritten
// (ANY /{proxy+}, no prefix strip) -- the current state after #18 reverted
// the strip. If that ever changes, this default has to move with it or
// every route 404s against a real deployed target.
export const POS_PREFIX = __ENV.POS_PREFIX ?? '/api/pos';

// The one thing every scenario needs and none of them should hand-roll:
// an owner token for a tenant that already has an attendant + a whole-
// shilling-priced product. Built once in setup(), reused by every VU.
export const THRESHOLDS = {
  http_req_failed: ['rate<0.01'],
  http_req_duration: ['p(95)<500'],
  checks: ['rate>0.99'],
};

// A KES 250.00 product (whole shillings -- M-Pesa cannot carry cents,
// ADR 0005/0006) so every VU's sale total is realistic and valid.
export const PRODUCT_PRICE_MINOR = 25_000;

// k6's JS runtime (goja) has no Node crypto.randomUUID(). POS's
// Idempotency-Key header only needs to be a unique non-empty string, not an
// actual UUID (services/pos/src/routes/sales.ts does no format check) --
// __VU/__ITER (k6 globals: this VU's id, this VU's iteration count) plus a
// timestamp and a random suffix is unique enough across an entire run
// without pulling in a UUID polyfill for a property nothing checks.
export function uniqueId(prefix = 'k6') {
  return `${prefix}-${__VU}-${__ITER}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}
