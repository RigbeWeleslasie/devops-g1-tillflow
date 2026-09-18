// baseline.js — stepped ramp to find the knee: the highest sustained load
// where http_req_failed/http_req_duration/checks all still hold. The
// script's job is to run a clean, evenly-stepped ramp and enforce the
// thresholds; identifying WHERE the knee fell out of the results is the k6
// analysis step (docs/slo-error-budgets.md's "Capacity" row), done after a
// run against a real deployed target -- not computed here.
//
// Usage:
//   k6 run --out json=k6/results/baseline-$(date +%s).json k6/baseline.js \
//     -e BASE_URL=https://<api-gw-url>
//
// Adjust STEP_TARGET/STEP_VUS via -e for a bigger/smaller target env
// without editing the script.
import { check, sleep } from 'k6';
import { bootstrapTenant, createSale, getSale, paySale } from './lib/pos.js';
import { THRESHOLDS, uniqueId } from './lib/config.js';

const STEP_VUS = Number(__ENV.STEP_VUS || 20); // VUs added per step
const STEP_DURATION = __ENV.STEP_DURATION || '2m';
const STEPS = Number(__ENV.STEPS || 5); // how many steps up before ramping down

function buildStages() {
  const stages = [];
  for (let i = 1; i <= STEPS; i++) {
    stages.push({ duration: STEP_DURATION, target: STEP_VUS * i });
  }
  stages.push({ duration: STEP_DURATION, target: 0 });
  return stages;
}

export const options = {
  stages: buildStages(),
  thresholds: THRESHOLDS,
};

export function setup() {
  return bootstrapTenant();
}

export default function (data) {
  const idempotencyKey = uniqueId('baseline');
  const quantity = 1 + (__ITER % 3); // 1-3 items, a little request-size variety

  const createRes = createSale(data, idempotencyKey, quantity);
  const created = check(createRes, {
    'POST /sales -> 201': (r) => r.status === 201,
    'sale is UNPAID': (r) => r.json('status') === 'UNPAID',
  });

  if (!created) {
    sleep(0.5);
    return;
  }
  const sale = createRes.json();

  const payRes = paySale(data, sale.id);
  check(payRes, { 'POST /sales/{id}/pay -> 202': (r) => r.status === 202 });

  const getRes = getSale(data, sale.id);
  check(getRes, { 'GET /sales/{id} -> 200': (r) => r.status === 200 });

  sleep(0.5);
}
