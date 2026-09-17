# web — multi-stage, TypeScript, npm-workspaces build context = repo root.
# Same golden-path requirements as services/_shared/docker/Dockerfile
# (digest-pinned, non-root, read-only rootfs, no `latest`) — see there for
# the digest-refresh command and the npm/yarn-removal rationale.
#
# Build from the repo root:
#   docker build -f services/web/Dockerfile -t devops-g1/web:<sha> .
#
# DRI: Rigbe (Product + POS).
FROM node:22.22-alpine3.24@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
COPY services/_shared/ts/package.json services/_shared/ts/package.json
COPY services/web/package.json services/web/package.json
RUN npm ci --workspace=@tillflow/shared --workspace=@tillflow/web --include-workspace-root

FROM deps AS build
COPY tsconfig.base.json ./
COPY services/_shared/ts/tsconfig.json services/_shared/ts/tsconfig.json
COPY services/_shared/ts/src services/_shared/ts/src
COPY services/web/tsconfig.json services/web/tsconfig.json
COPY services/web/src services/web/src
RUN npm run build --workspace=@tillflow/shared && \
    npm run build --workspace=@tillflow/web

FROM deps AS prod-deps
RUN npm ci --workspace=@tillflow/shared --workspace=@tillflow/web --include-workspace-root --omit=dev && \
    mkdir -p services/web/node_modules
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

ARG COMMIT_SHA=unknown
ARG IMAGE_DIGEST=unknown

ENV NODE_ENV=production \
    PORT=8080 \
    COMMIT_SHA=${COMMIT_SHA} \
    IMAGE_DIGEST=${IMAGE_DIGEST} \
    SERVICE_NAME=web \
    OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 \
    OTEL_SERVICE_NAME=web

COPY --from=prod-deps /app/node_modules ./node_modules/
COPY --from=prod-deps /app/services/web/node_modules services/web/node_modules/
COPY --from=build /app/services/_shared/ts/dist services/_shared/ts/dist/
COPY --from=build /app/services/web/dist services/web/dist/
COPY services/_shared/ts/package.json services/_shared/ts/package.json
COPY services/web/package.json services/web/package.json

WORKDIR /app/services/web

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/server.js"]
