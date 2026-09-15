/**
 * /health, /ready and /version for a worker that has no API.
 *
 * ECS probes /health for liveness and the golden path expects /version to
 * report the running artifact, so the worker serves the same three routes
 * every other service does — just over node:http rather than Fastify, since
 * there is nothing else to serve.
 *
 * /ready checks the database, because a worker that cannot reach the ledger
 * cannot do its job. /health deliberately does not: a DB blip must not make
 * ECS restart a task that is otherwise fine.
 */
import http from 'node:http';
import type { Db } from './db.js';

export interface HealthServerOptions {
  db: Db;
  port: number;
}

export function createHealthServer(opts: HealthServerOptions) {
  let draining = false;

  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (path === '/health') {
      return send(res, 200, { status: 'ok', service: 'commission' });
    }

    if (path === '/version') {
      return send(res, 200, {
        service: 'commission',
        sha: process.env['COMMIT_SHA'] ?? 'unknown',
        digest: process.env['IMAGE_DIGEST'] ?? 'unknown',
        environment: process.env['ENVIRONMENT'] ?? 'dev',
      });
    }

    if (path === '/ready') {
      if (draining) return send(res, 503, { status: 'draining', service: 'commission' });
      opts.db
        .query('SELECT 1')
        .then(() => send(res, 200, { status: 'ready', service: 'commission' }))
        .catch((err: unknown) =>
          send(res, 503, {
            status: 'not_ready',
            service: 'commission',
            reason: err instanceof Error ? err.message : 'db unreachable',
          }),
        );
      return;
    }

    return send(res, 404, { error: 'not_found' });
  });

  return {
    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, '0.0.0.0', () => resolve());
      });
    },
    close(): Promise<void> {
      draining = true;
      return new Promise((resolve, reject) => {
        server.closeIdleConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}
