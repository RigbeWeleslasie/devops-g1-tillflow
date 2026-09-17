# Payments API — multi-stage, TypeScript. Same golden-path requirements as
# services/_shared/docker/Dockerfile (multi-stage, digest-pinned, non-root,
# read-only rootfs, no `latest`) and the same npm-workspaces layout as
# services/pos/Dockerfile: this service depends on @tillflow/shared AND
# @tillflow/mpesa, so the build context is the REPO ROOT.
#
# Build from the repo root:
#   docker build -f services/payments/Dockerfile -t devops-g1/payments:<sha> .
#
# DRI: Nebyat (Payments + integrity). Base image + hardening: Meron's pattern,
# reused verbatim — see services/_shared/docker/Dockerfile.
FROM node:22.22-alpine3.24@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd AS base
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — the whole workspace slice this service needs. Cached independently of
# source; only a package.json / lockfile edit invalidates it.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json* ./
COPY services/_shared/ts/package.json services/_shared/ts/package.json
COPY services/_shared/mpesa/package.json services/_shared/mpesa/package.json
COPY services/payments/package.json services/payments/package.json
RUN npm ci --workspace=@tillflow/shared --workspace=@tillflow/mpesa --workspace=@tillflow/payments --include-workspace-root

# ---------------------------------------------------------------------------
# build — shared, then mpesa, then payments (tsc -b project references resolve
# the order either way; explicit so the build log reads plainly).
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY services/_shared/ts/tsconfig.json services/_shared/ts/tsconfig.json
COPY services/_shared/ts/src services/_shared/ts/src
COPY services/_shared/mpesa/tsconfig.json services/_shared/mpesa/tsconfig.json
COPY services/_shared/mpesa/src services/_shared/mpesa/src
COPY services/payments/tsconfig.json services/payments/tsconfig.json
COPY services/payments/src services/payments/src
RUN npm run build --workspace=@tillflow/shared && \
    npm run build --workspace=@tillflow/mpesa && \
    npm run build --workspace=@tillflow/payments

# Production-only node_modules: no typescript, tsx, pg-mem, @types/*.
FROM deps AS prod-deps
RUN npm ci --workspace=@tillflow/shared --workspace=@tillflow/mpesa --workspace=@tillflow/payments --include-workspace-root --omit=dev && \
    mkdir -p services/_shared/mpesa/node_modules services/payments/node_modules
# npm hoists workspace deps to the root node_modules; a per-workspace
# node_modules only exists when a version conflicts with the hoisted one.
# The mkdir guarantees the runtime COPYs below have a source either way
# (a COPY of a missing path fails the build).

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM base AS runtime

RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Amazon's RDS root CAs. `pg` 8.23 treats `sslmode=require` as `verify-full`,
# and Node's built-in trust store holds public web CAs, not Amazon's private RDS
# ones -- so without this every connection dies with SELF_SIGNED_CERT_IN_CHAIN.
# Committed rather than fetched at build time; see services/_shared/certs/README.md.
COPY services/_shared/certs/rds-ca.pem /etc/ssl/certs/rds-ca.pem

ARG COMMIT_SHA=unknown
ARG IMAGE_DIGEST=unknown

ENV NODE_ENV=production \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-ca.pem \
    PORT=8080 \
    COMMIT_SHA=${COMMIT_SHA} \
    IMAGE_DIGEST=${IMAGE_DIGEST} \
    SERVICE_NAME=payments \
    OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 \
    OTEL_SERVICE_NAME=payments

COPY --from=prod-deps /app/node_modules ./node_modules/
COPY --from=prod-deps /app/services/_shared/mpesa/node_modules services/_shared/mpesa/node_modules/
COPY --from=prod-deps /app/services/payments/node_modules services/payments/node_modules/
COPY --from=build /app/services/_shared/ts/dist services/_shared/ts/dist/
COPY --from=build /app/services/_shared/mpesa/dist services/_shared/mpesa/dist/
COPY --from=build /app/services/payments/dist services/payments/dist/
COPY services/_shared/ts/package.json services/_shared/ts/package.json
COPY services/_shared/mpesa/package.json services/_shared/mpesa/package.json
COPY services/payments/package.json services/payments/package.json
COPY services/payments/migrations services/payments/migrations/

WORKDIR /app/services/payments

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/server.js"]
