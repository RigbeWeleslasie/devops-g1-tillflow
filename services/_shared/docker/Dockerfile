# Shared multi-stage base image — the Docker pattern every service inherits.
#
# DRI: Meron (Platform + delivery). Golden-path requirements (brief §3):
#   - multi-stage
#   - base image pinned by DIGEST, not tag (a tag can be repointed; a digest cannot)
#   - non-root
#   - read-only root filesystem (enforced in the ECS task definition)
#   - no `latest` anywhere
#
# node:22.22-alpine3.24 (Node 22 LTS). Both the tag and the digest are given: the
# tag documents what it is, the digest is what actually resolves.
# Refresh with:  docker manifest inspect node:22.22-alpine3.24
FROM node:22.22-alpine3.24@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd AS base
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — separate stage so dependency installation caches independently of source
# ---------------------------------------------------------------------------
FROM base AS deps
# package.json is required (this build's reference service ships one); the
# lockfile glob is optional so services that haven't added one yet still
# build -- a bare `package*.json` glob errors when it matches nothing, so the
# required and optional files are listed as separate sources.
COPY package.json package-lock.json* ./
# No dependencies yet; `npm ci` would fail without a lockfile. `mkdir -p` makes
# node_modules exist either way, so the runtime stage's COPY below never fails
# on a missing directory once a real service adds a lockfile.
RUN mkdir -p node_modules && if [ -f package-lock.json ]; then npm ci --omit=dev; fi

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM base AS runtime

# Build args -> runtime env. The pipeline passes the real values; the defaults
# keep a local `docker build` working.
ARG COMMIT_SHA=unknown
ARG IMAGE_DIGEST=unknown
ARG SERVICE_NAME=shared

ENV NODE_ENV=production \
    PORT=8080 \
    COMMIT_SHA=${COMMIT_SHA} \
    IMAGE_DIGEST=${IMAGE_DIGEST} \
    SERVICE_NAME=${SERVICE_NAME} \
    # Apps export OTLP to the ADOT sidecar over the task's shared localhost.
    OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 \
    OTEL_SERVICE_NAME=${SERVICE_NAME}

COPY --from=deps /app/node_modules ./node_modules/
COPY package.json app.js ./

# Run as a non-root user that owns nothing writable. `node` (uid 1000) ships
# with the base image.
USER node

EXPOSE 8080

# A read-only root filesystem means no writable /tmp unless ECS mounts one; the
# app writes only to stdout, so nothing is needed here.

# Liveness for local/dev runs. ECS and the ALB use their own probes against
# /health and /ready -- this is a convenience, not the production check.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "app.js"]
