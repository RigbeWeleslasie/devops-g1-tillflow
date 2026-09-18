# Commission worker — multi-stage, TypeScript. Same golden path as
# services/pos and services/payments (multi-stage, digest-pinned, non-root,
# read-only rootfs, no `latest`), built from the REPO ROOT because this
# service depends on @tillflow/shared.
#
# Build from the repo root:
#   docker build -f services/commission/Dockerfile -t devops-g1/commission:<sha> .
#
# Note it does NOT depend on @tillflow/mpesa. That is deliberate and worth
# seeing in the build: the worker has no way to talk to Daraja, by
# construction as well as by IAM (infra/data.tf grants the daraja secret to
# the payments task role alone).
#
# DRI: Nebyat (Payments + integrity). Base image + hardening: Meron's
# pattern, reused verbatim — see services/_shared/docker/Dockerfile.
FROM node:22.22-alpine3.24@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
COPY services/_shared/ts/package.json services/_shared/ts/package.json
COPY services/commission/package.json services/commission/package.json
RUN npm ci --workspace=@tillflow/shared --workspace=@tillflow/commission --include-workspace-root

FROM deps AS build
COPY tsconfig.base.json ./
COPY services/_shared/ts/tsconfig.json services/_shared/ts/tsconfig.json
COPY services/_shared/ts/src services/_shared/ts/src
COPY services/commission/tsconfig.json services/commission/tsconfig.json
COPY services/commission/src services/commission/src
RUN npm run build --workspace=@tillflow/shared && \
    npm run build --workspace=@tillflow/commission

# Production-only node_modules: no typescript, tsx, pg-mem, @types/*.
FROM deps AS prod-deps
RUN npm ci --workspace=@tillflow/shared --workspace=@tillflow/commission --include-workspace-root --omit=dev && \
    mkdir -p services/commission/node_modules
# npm hoists workspace deps to the root node_modules; a per-workspace
# node_modules only exists when a version conflicts with the hoisted one.
# The mkdir guarantees the runtime COPY below has a source either way
# (a COPY of a missing path fails the build).

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
    SERVICE_NAME=commission \
    OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 \
    OTEL_SERVICE_NAME=commission

COPY --from=prod-deps /app/node_modules ./node_modules/
COPY --from=prod-deps /app/services/commission/node_modules services/commission/node_modules/
COPY --from=build /app/services/_shared/ts/dist services/_shared/ts/dist/
COPY --from=build /app/services/commission/dist services/commission/dist/
COPY services/_shared/ts/package.json services/_shared/ts/package.json
COPY services/commission/package.json services/commission/package.json

WORKDIR /app/services/commission

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/worker.js"]
