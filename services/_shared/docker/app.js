// Reference service — the golden path every TillFlow service inherits.
//
// DRI: Meron (Platform + delivery).
//
// Deliberately dependency-free: it exists to prove the platform (ECS task boot,
// ADOT sidecar, ALB health checks, pipeline deploy by digest), not to do product
// work. Rigbe and Nebyat replace the routes; the operational contract below --
// /health, /ready, /version, JSON logs, OTLP to the sidecar -- stays fixed.

'use strict';

const http = require('http');
const os = require('os');

const PORT = Number(process.env.PORT || 8080);
const SERVICE = process.env.SERVICE_NAME || 'shared';
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';

// Injected at build time by the pipeline. No `latest` tags anywhere: the commit
// SHA and the immutable image digest are what identify a running release, and
// /version is how the post-deploy smoke test proves which one it reached.
const COMMIT_SHA = process.env.COMMIT_SHA || 'unknown';
const IMAGE_DIGEST = process.env.IMAGE_DIGEST || 'unknown';

// Readiness is separate from liveness. A task that is alive but not ready must
// fail /ready (so the ALB stops sending it traffic) while still passing /health
// (so ECS does not kill it). Drain support: SIGTERM flips this false first.
let ready = false;
let shuttingDown = false;

// --- logging ---------------------------------------------------------------
// JSON lines with trace_id/span_id so CloudWatch Logs Insights can join logs to
// traces. The sidecar reads W3C traceparent; we echo whatever arrived.
function log(level, msg, extra = {}) {
  const rec = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE,
    environment: ENVIRONMENT,
    version: COMMIT_SHA,
    message: msg,
    ...extra,
  };
  process.stdout.write(JSON.stringify(rec) + '\n');
}

function traceFields(req) {
  // traceparent: 00-<32 hex trace id>-<16 hex span id>-<flags>
  const tp = req.headers['traceparent'];
  if (typeof tp === 'string') {
    const parts = tp.split('-');
    if (parts.length >= 4) return { trace_id: parts[1], span_id: parts[2] };
  }
  return {};
}

// --- routes ----------------------------------------------------------------

const server = http.createServer((req, res) => {
  const started = process.hrtime.bigint();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  const send = (status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);

    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    log('info', 'request', {
      http_method: req.method,
      http_path: url.pathname,
      http_status: status,
      duration_ms: Math.round(durationMs * 100) / 100,
      ...traceFields(req),
    });
  };

  // The edge routes by path prefix (ALB listener rules on /pos/*, /payments/*,
  // and API Gateway's ANY /{proxy+}) and forwards the RAW path -- neither strips
  // it. So the app sees /pos/health, not /health. Strip our own prefix here
  // rather than teaching every caller two spellings; an unprefixed request still
  // works, which keeps the container's own HEALTHCHECK and local runs simple.
  const routePath = url.pathname.replace(
    new RegExp(`^/(?:api/)?${SERVICE}(?=/|$)`),
    '',
  ) || '/';

  switch (routePath) {
    // Liveness: is the process functioning? Must NOT check dependencies -- a
    // database blip should not cause ECS to restart every healthy task.
    case '/health':
      return send(200, { status: 'ok', service: SERVICE });

    // Readiness: should this task receive traffic? Dependency checks belong
    // here. Returns 503 during shutdown so the ALB drains us before exit.
    case '/ready':
      return ready && !shuttingDown
        ? send(200, { status: 'ready', service: SERVICE })
        : send(503, { status: shuttingDown ? 'draining' : 'starting', service: SERVICE });

    // Release identity -- the artifact-identity evidence the brief asks for.
    case '/version':
      return send(200, {
        service: SERVICE,
        sha: COMMIT_SHA,
        digest: IMAGE_DIGEST,
        environment: ENVIRONMENT,
        host: os.hostname(),
      });

    default:
      return send(404, { error: 'not_found', path: url.pathname });
  }
});

// --- lifecycle -------------------------------------------------------------

server.listen(PORT, '0.0.0.0', () => {
  ready = true;
  log('info', 'listening', { port: PORT, pid: process.pid });
});

// ECS sends SIGTERM, waits, then SIGKILL. Fail readiness first so the ALB takes
// us out of rotation, give in-flight requests a moment, then exit cleanly.
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown_started', { signal });

  setTimeout(() => {
    server.close(() => {
      log('info', 'shutdown_complete', {});
      process.exit(0);
    });
  }, Number(process.env.DRAIN_MS || 5000));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  log('error', 'uncaught_exception', { error: err.message, stack: err.stack });
  process.exit(1);
});
