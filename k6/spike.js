// spike.js — sudden 10x for 2 min, then back down. Tests recovery
// behaviour, not sustained capacity: a spike is allowed to bend (the
// thresholds are checked, but a spike failing them is expected and
// informative, not a build-breaker the way baseline/soak failing is).
//
// Usage:
//   k6 run k6/spike.js -e BASE_URL=https://<api-gw-url> -e BASELINE_VUS=10
import { check, sleep } from 'k6';
import { bootstrapTenant, createSale, getSale, paySale } from './lib/pos.js';
import { THRESHOLDS, uniqueId } from './lib/config.js';

const BASELINE_VUS = Number(__ENV.BASELINE_VUS || 10);
const SPIKE_VUS = BASELINE_VUS * 10;

export const options = {
  stages: [
    { duration: '30s', target: BASELINE_VUS }, // warm up at a normal load
    { duration: '30s', target: BASELINE_VUS }, // hold
    { duration: '10s', target: SPIKE_VUS }, // the spike: 10x, fast
    { duration: '2m', target: SPIKE_VUS }, // hold the spike
    { duration: '30s', target: BASELINE_VUS }, // back down
    { duration: '1m', target: BASELINE_VUS }, // recovery: does it settle back to healthy?
    { duration: '20s', target: 0 },
  ],
  thresholds: THRESHOLDS,
};

export function setup() {
  return bootstrapTenant();
}

export default function (data) {
  const idempotencyKey = uniqueId('spike');

  const createRes = createSale(data, idempotencyKey);
  const created = check(createRes, {
    'POST /sales -> 201': (r) => r.status === 201,
  });

  if (!created) {
    sleep(0.2);
    return;
  }
  const sale = createRes.json();

  const payRes = paySale(data, sale.id);
  check(payRes, { 'POST /sales/{id}/pay -> 202': (r) => r.status === 202 });

  sleep(0.2);
}
