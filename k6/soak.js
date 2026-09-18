// soak.js — >= 15 min at ~80% of the baseline knee, looking for leaks and
// queue growth rather than raw throughput. SOAK_VUS has no way to default
// correctly on its own (the knee is only known after a real baseline.js
// run against the deployed target) -- it defaults to a conservative
// placeholder and MUST be overridden once that number exists.
//
// Usage:
//   k6 run --out json=k6/results/soak-$(date +%s).json k6/soak.js \
//     -e BASE_URL=https://<api-gw-url> -e SOAK_VUS=<0.8 * baseline knee> \
//     -e SOAK_DURATION=20m
import { check, sleep } from 'k6';
import { bootstrapTenant, createSale, getSale, paySale } from './lib/pos.js';
import { THRESHOLDS, uniqueId } from './lib/config.js';

const SOAK_VUS = Number(__ENV.SOAK_VUS || 15); // placeholder -- see header
const SOAK_DURATION = __ENV.SOAK_DURATION || '15m';
const RAMP = '1m';

export const options = {
  stages: [
    { duration: RAMP, target: SOAK_VUS },
    { duration: SOAK_DURATION, target: SOAK_VUS },
    { duration: RAMP, target: 0 },
  ],
  thresholds: THRESHOLDS,
};

export function setup() {
  return bootstrapTenant();
}

export default function (data) {
  const idempotencyKey = uniqueId('soak');

  const createRes = createSale(data, idempotencyKey);
  const created = check(createRes, {
    'POST /sales -> 201': (r) => r.status === 201,
  });

  if (!created) {
    sleep(1);
    return;
  }
  const sale = createRes.json();

  const payRes = paySale(data, sale.id);
  check(payRes, { 'POST /sales/{id}/pay -> 202': (r) => r.status === 202 });

  // A soak's whole point is steady, sustained pressure -- checking the sale
  // back adds a read alongside every write/pay pair for the duration, which
  // is what would surface a slow leak (connection pool exhaustion, an
  // unbounded queue) that a short baseline run wouldn't have time to show.
  const getRes = getSale(data, sale.id);
  check(getRes, { 'GET /sales/{id} -> 200': (r) => r.status === 200 });

  sleep(1);
}
