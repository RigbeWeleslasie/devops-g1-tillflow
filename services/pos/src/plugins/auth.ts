/**
 * Auth — a real, enforced JWT + tenant/role scoping, deliberately WITHOUT a
 * full identity provider (signup, password, OAuth). That's out of scope for
 * G2 (see services/pos/README.md "Auth scope"); what G2 needs proven is that
 * once a caller IS authenticated, tenant_id comes from the token and never
 * from the request, and cross-tenant/cross-role access is rejected the way
 * ADR 0007 specifies. `/dev/tokens` mints a token for a known user directly
 * — a real IdP integration swaps that one route out later without touching
 * anything downstream, since every other route only ever reads
 * `request.principal`.
 */
import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import type { Principal, UserRole } from '../types.js';

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (
      role: UserRole,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface AuthPluginOptions {
  jwtSecret: string;
  db: Db;
  /**
   * Mounts POST /dev/tokens. Defaults to DEV_AUTH_ENABLED == 'true' --
   * fail CLOSED. Not opt-out, opt-in.
   *
   * Deliberately NOT keyed on NODE_ENV: the Dockerfile bakes
   * NODE_ENV=production into every real image (correct -- that's a
   * Node/framework performance flag, not an environment name), but this
   * capstone's one deployed environment is also the only place k6, the
   * game-day drill, and anyone testing the real system can get a token at
   * all -- there is no other login flow (see the README's "Auth scope").
   * Gating on NODE_ENV meant /dev/tokens was silently unreachable the
   * moment a real image ran, discovered while wiring k6 against a
   * deployed target (docs/scar-log.md). DEV_AUTH_ENABLED is the explicit,
   * separately-controlled switch this needs.
   *
   * It must default OFF: POST /tenants is intentionally unauthenticated
   * (tenant #1 bootstrap), so an opt-out default chains straight through
   * it -- POST /tenants picks its own externalAuthId, POST /dev/tokens
   * mints that same identity a 12h owner JWT, no credential required at
   * any step (found via PR #21 review, docs/scar-log.md). The env var is
   * set explicitly to "true" in the sandbox task definition
   * (infra/service-mesh.tf, pos service_env) so the grant is a line in a
   * Terraform diff someone reviews, not an invisible default.
   */
  devAuthEnabled?: boolean;
}

export default fp<AuthPluginOptions>(async function authPlugin(app: FastifyInstance, opts) {
  await app.register(fastifyJwt, { secret: opts.jwtSecret });

  app.decorate('requireAuth', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = await request.jwtVerify<{ sub: string; tenantId: string; role: UserRole }>();
      request.principal = { userId: payload.sub, tenantId: payload.tenantId, role: payload.role };
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.decorate('requireRole', (role: UserRole) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      // requireAuth must run first (routes register it before requireRole).
      if (!request.principal) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      if (request.principal.role !== role) {
        return reply.code(403).send({ error: 'forbidden', reason: `requires role ${role}` });
      }
    };
  });

  const devAuthEnabled = opts.devAuthEnabled ?? process.env['DEV_AUTH_ENABLED'] === 'true';
  if (devAuthEnabled) {
    app.post<{ Body: { tenantId: string; externalAuthId: string } }>(
      '/dev/tokens',
      async (request, reply) => {
        const { tenantId, externalAuthId } = request.body;
        const result = await opts.db.query<{
          id: string;
          tenant_id: string;
          role: UserRole;
        }>('SELECT id, tenant_id, role FROM users WHERE tenant_id = $1 AND external_auth_id = $2', [
          tenantId,
          externalAuthId,
        ]);
        const user = result.rows[0];
        if (!user) {
          return reply.code(404).send({ error: 'not_found' });
        }
        const token = app.jwt.sign(
          { sub: user.id, tenantId: user.tenant_id, role: user.role },
          { expiresIn: '12h' },
        );
        return reply.send({ token });
      },
    );
  }
});
