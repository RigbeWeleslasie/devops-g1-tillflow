/**
 * Standard /health, /ready, /version routes — the golden path every service
 * exposes (docs/architecture.md, services/_shared/README.md). Same contract
 * as the JS reference service in services/_shared/docker/app.js:
 *   - /health: liveness. Never checks dependencies — a DB blip must not make
 *     ECS restart an otherwise-healthy task.
 *   - /ready: readiness. Calls the caller-supplied `checkReady`, which SHOULD
 *     check real dependencies (DB, cache) once the service has any. Returns
 *     503 while draining so the ALB stops sending traffic before SIGTERM's
 *     grace period runs out.
 *   - /version: the artifact-identity evidence the brief asks for.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export interface ReadinessCheck {
  (): Promise<{ ready: boolean; reason?: string }>;
}

export interface HealthPluginOptions {
  serviceName: string;
  checkReady?: ReadinessCheck;
}

export const healthPlugin: FastifyPluginAsync<HealthPluginOptions> = async (
  app: FastifyInstance,
  opts: HealthPluginOptions,
) => {
  let shuttingDown = false;
  app.addHook('onClose', async () => {
    shuttingDown = true;
  });

  const commitSha = process.env['COMMIT_SHA'] ?? 'unknown';
  const imageDigest = process.env['IMAGE_DIGEST'] ?? 'unknown';
  const environment = process.env['ENVIRONMENT'] ?? 'dev';

  app.get('/health', async (_req, reply) => {
    return reply.send({ status: 'ok', service: opts.serviceName });
  });

  app.get('/ready', async (_req, reply) => {
    if (shuttingDown) {
      return reply.code(503).send({ status: 'draining', service: opts.serviceName });
    }
    if (opts.checkReady) {
      const result = await opts.checkReady();
      if (!result.ready) {
        return reply
          .code(503)
          .send({ status: 'not_ready', service: opts.serviceName, reason: result.reason });
      }
    }
    return reply.send({ status: 'ready', service: opts.serviceName });
  });

  app.get('/version', async (_req, reply) => {
    return reply.send({
      service: opts.serviceName,
      sha: commitSha,
      digest: imageDigest,
      environment,
    });
  });
};
