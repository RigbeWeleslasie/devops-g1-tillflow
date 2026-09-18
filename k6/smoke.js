// smoke.js — 1-5 VUs, 1 min. Does it work at all?
//
// Run this before anything heavier: if smoke fails, baseline/spike/soak
// will too, and more slowly.
//
// Usage:
//   k6 run k6/smoke.js -e BASE_URL=https://<api-gw-url>
import { check, sleep } from 'k6';
import { bootstrapTenant, createSale, getSale, paySale } from './lib/pos.js';
import { THRESHOLDS, uniqueId } from './lib/config.js';

export const options = {
  stages: [
    { duration: '20s', target: 5 },
    { duration: '20s', target: 5 },
    { duration: '20s', target: 0 },
  ],
  thresholds: THRESHOLDS,
};

export function setup() {
  return bootstrapTenant();
}

export default function (data) {
  const idempotencyKey = uniqueId('smoke');

  const createRes = createSale(data, idempotencyKey);
  check(createRes, {
    'POST /sales -> 201': (r) => r.status === 201,
    'sale is UNPAID': (r) => r.json('status') === 'UNPAID',
    'total is server-computed (not 0)': (r) => r.json('totalMinor') > 0,
  });

  if (createRes.status !== 201) {
    sleep(1);
    return;
  }
  const sale = createRes.json();

  const payRes = paySale(data, sale.id);
  check(payRes, {
    'POST /sales/{id}/pay -> 202': (r) => r.status === 202,
  });

  const getRes = getSale(data, sale.id);
  check(getRes, {
    'GET /sales/{id} -> 200': (r) => r.status === 200,
  });

  sleep(1);
}
