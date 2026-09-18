// POS API helpers -- one function per call in the sale -> pay flow, plus the
// one-time tenant bootstrap every scenario's setup() calls exactly once.
//
// Deliberately thin: no k6 checks live in here (checks belong in the
// scenario files, next to the thresholds they back), just request/response
// plumbing so smoke/baseline/spike/soak don't each reimplement it.
import http from 'k6/http';
import { BASE_URL, POS_PREFIX, PRODUCT_PRICE_MINOR } from './config.js';

const posUrl = (path) => `${BASE_URL}${POS_PREFIX}${path}`;

/**
 * Runs once from setup() (k6 guarantees this executes on a single VU before
 * any scenario iteration starts): creates a fresh tenant, an attendant, and
 * a product, returning everything every iteration needs. A real POST
 * against a real deployment, not a fixture -- if tenant bootstrap is
 * broken, the k6 run fails loudly in setup() rather than confusingly on
 * iteration 1.
 */
export function bootstrapTenant() {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  const tenantRes = http.post(
    posUrl('/tenants'),
    JSON.stringify({
      name: `k6 load test ${suffix}`,
      tillNumber: '174379', // Daraja sandbox's well-known test till
      ownerExternalAuthId: `k6-owner-${suffix}`,
      ownerDisplayName: 'k6 Owner',
    }),
    { headers: { 'content-type': 'application/json' } },
  );
  if (tenantRes.status !== 201) {
    throw new Error(`bootstrap: POST /tenants -> ${tenantRes.status} ${tenantRes.body}`);
  }
  const { tenant, owner } = tenantRes.json();

  const tokenRes = http.post(
    posUrl('/dev/tokens'),
    JSON.stringify({ tenantId: tenant.id, externalAuthId: owner.externalAuthId ?? `k6-owner-${suffix}` }),
    { headers: { 'content-type': 'application/json' } },
  );
  if (tokenRes.status !== 200) {
    throw new Error(
      `bootstrap: POST /dev/tokens -> ${tokenRes.status} ${tokenRes.body} ` +
        `(DEV_AUTH_ENABLED must be on against this target -- see services/pos/README.md)`,
    );
  }
  const ownerToken = tokenRes.json('token');
  const bootstrapAuthHeaders = {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
  };

  const attendantRes = http.post(
    posUrl(`/tenants/${tenant.id}/attendants`),
    JSON.stringify({
      externalAuthId: `k6-attendant-${suffix}`,
      displayName: 'k6 Attendant',
      msisdn: '254708374149', // Daraja sandbox's well-known test MSISDN
    }),
    bootstrapAuthHeaders,
  );
  if (attendantRes.status !== 201) {
    throw new Error(`bootstrap: POST /tenants/:id/attendants -> ${attendantRes.status} ${attendantRes.body}`);
  }
  const attendant = attendantRes.json();

  const productRes = http.post(
    posUrl(`/tenants/${tenant.id}/products`),
    JSON.stringify({ name: 'k6 Widget', unitPriceMinor: PRODUCT_PRICE_MINOR }),
    bootstrapAuthHeaders,
  );
  if (productRes.status !== 201) {
    throw new Error(`bootstrap: POST /tenants/:id/products -> ${productRes.status} ${productRes.body}`);
  }
  const product = productRes.json();

  return {
    tenantId: tenant.id,
    ownerToken,
    attendantId: attendant.id,
    productId: product.id,
  };
}

function authHeaders(token) {
  return { headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } };
}

/** POST /sales -- a fresh Idempotency-Key per call, matching one real sale per call. */
export function createSale(data, idempotencyKey, quantity = 1) {
  return http.post(
    posUrl('/sales'),
    JSON.stringify({
      attendantId: data.attendantId,
      items: [{ productId: data.productId, quantity }],
    }),
    {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${data.ownerToken}`,
        'idempotency-key': idempotencyKey,
      },
    },
  );
}

/**
 * POST /sales/{id}/pay -- the Daraja sandbox's well-known test MSISDN.
 * Every VU pays the same MSISDN + PRODUCT_PRICE_MINOR. Fine under the fake
 * adapter (KES 250 -> deterministic success, ADR 0005) -- if a scenario is
 * ever changed to hit a timeout path, Payments' findAdoptableCharge
 * (services/payments/src/services/callbackService.ts) can no longer tell
 * same-amount concurrent charges apart and reports 'ambiguous' for all of
 * them. By design there, but surprising in a load-test report if nobody
 * expects it -- vary amount or MSISDN per VU first if that path is added.
 */
export function paySale(data, saleId) {
  return http.post(
    posUrl(`/sales/${saleId}/pay`),
    JSON.stringify({ customerMsisdn: '254708374149' }),
    authHeaders(data.ownerToken),
  );
}

/** GET /sales/{id} */
export function getSale(data, saleId) {
  return http.get(posUrl(`/sales/${saleId}`), authHeaders(data.ownerToken));
}
