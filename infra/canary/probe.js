/**
 * External uptime probe — TillFlow / devops-g1.
 *
 * DRI: Meron (Platform + delivery). SLI definitions: docs/slo-error-budgets.md
 * (DRI: Rigbe).
 *
 * This is the G3 "external probe": it runs in AWS Synthetics, OUTSIDE the VPC,
 * and reaches the stack the way an attendant's browser does -- through the
 * public API Gateway edge. That is the point. ECS health checks and ALB target
 * health both sit inside the network and stay green when the edge itself is
 * broken (API Gateway 5xx, a dead VPC Link, a bad route). Only a probe from
 * outside can fail on those, so only this one measures the user's experience.
 *
 * It asserts /ready, not /health. Per services/_shared/ts/src/health.ts,
 * /health is liveness and deliberately never touches dependencies, so it
 * answers 200 with the database down. /ready calls the real dependency checks.
 * A probe that stays green while nobody can record a sale is worse than no
 * probe, because it manufactures confidence.
 *
 * Success requires BOTH a 2xx and the expected JSON body: a proxy or error
 * page returning 200 with HTML is a failure, not a pass.
 */
const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');

// Injected by Terraform (infra/observability.tf) so this file never hardcodes
// an environment or an endpoint.
const BASE_URL = process.env.TARGET_BASE_URL;
// Comma-separated. Only services with public ingress and a running task belong
// here -- see the `canary_targets` local in observability.tf for why the list
// is derived rather than hardcoded to all four services.
const TARGETS = (process.env.TARGET_SERVICES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const TIMEOUT_MS = 10000;

/**
 * One request, asserted on status AND body.
 *
 * Uses executeHttpStep so each service becomes its own named step: the step
 * name is what appears in the canary run report and in the failure detail, so
 * an alert says which service broke instead of just "canary failed".
 */
async function probe(service) {
  const url = `${BASE_URL}/${service}/ready`;

  await synthetics.executeHttpStep(
    `ready:${service}`,
    {
      url,
      method: 'GET',
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'tillflow-synthetics-canary' },
    },
    async (res) => {
      // Collect the body before judging it; a streamed response must be
      // drained or the socket can hang until the canary times out.
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      await new Promise((resolve, reject) => {
        res.on('end', resolve);
        res.on('error', reject);
      });

      if (res.statusCode < 200 || res.statusCode > 299) {
        throw new Error(`${service}: expected 2xx, got ${res.statusCode} -- ${body.slice(0, 200)}`);
      }

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        // A 200 carrying HTML means something in front of the app answered
        // instead of the app: an error page, a redirect to a login, a proxy.
        throw new Error(`${service}: 200 but body was not JSON -- ${body.slice(0, 200)}`);
      }

      if (parsed.status !== 'ready') {
        throw new Error(`${service}: expected status "ready", got "${parsed.status}"`);
      }
      if (parsed.service !== service) {
        // Catches edge mis-routing: /pos/ready answered by web still returns a
        // valid 200 "ready" body, and would otherwise pass while routing is
        // silently wrong. This is exactly the class of bug the strip-prefix fix
        // (PR #17) addressed.
        throw new Error(`${service}: response came from "${parsed.service}" -- edge mis-routing`);
      }

      log.info(`${service}: ready`);
    },
  );
}

exports.handler = async function () {
  if (!BASE_URL) throw new Error('TARGET_BASE_URL is not set');
  if (TARGETS.length === 0) throw new Error('TARGET_SERVICES is empty -- nothing to probe');

  // Sequential, not parallel: the canary is a uptime signal, not a load test.
  // Concurrent requests from the probe would add load that the SLO's own
  // latency numbers then have to account for.
  for (const service of TARGETS) {
    await probe(service);
  }
};
