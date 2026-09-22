# M-Pesa stub-server — a fake Daraja over HTTP, as a container.
#
# ADR 0005 names this: "a tiny HTTP stub service" that speaks Daraja's exact
# wire format and is backed by FakeAdapter, so a deployed Payments can run with
# MPESA_ADAPTER=daraja (satisfying the prod guard in payments/src/config.ts)
# while DARAJA_BASE_URL points here instead of at Safaricom. The real
# DarajaAdapter HTTP path — OAuth, timeouts, callback delivery over the network
# — is what gets exercised; only the far end is deterministic.
#
# It existed as code (src/stub-server.ts, "can run as a throwaway ECS task or a
# sidecar container") but nothing could build it, so nothing ever deployed it.
# That is why every STK push from the deployed Payments timed out: the adapter
# was real, the credentials were placeholders, and there was nothing to point
# it at. This image is the missing piece. It needs no Safaricom account — the
# stub accepts any Basic credentials for OAuth and any Bearer token after.
#
# Build from the repo root:
#   docker build -f services/_shared/mpesa/Dockerfile -t devops-g1/mpesa-stub:<sha> .
#
# Run:
#   docker run -p 9090:9090 devops-g1/mpesa-stub:<sha>
#   curl localhost:9090/health   -> {"status":"ok","service":"mpesa-stub","pending":0}
#
# Same hardening as services/payments/Dockerfile (digest-pinned base, non-root,
# no npm at runtime). Dependency-free at runtime except @tillflow/shared, so the
# image is small and the attack surface is one node:http server.
#
# DRI: Nebyat (Payments + integrity); path co-owned with Meron.
FROM node:22.22-alpine3.24@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
COPY services/_shared/ts/package.json services/_shared/ts/package.json
COPY services/_shared/mpesa/package.json services/_shared/mpesa/package.json
RUN npm ci --workspace=@tillflow/shared --workspace=@tillflow/mpesa --include-workspace-root

FROM deps AS build
COPY tsconfig.base.json ./
COPY services/_shared/ts/tsconfig.json services/_shared/ts/tsconfig.json
COPY services/_shared/ts/src services/_shared/ts/src
COPY services/_shared/mpesa/tsconfig.json services/_shared/mpesa/tsconfig.json
COPY services/_shared/mpesa/src services/_shared/mpesa/src
RUN npm run build --workspace=@tillflow/shared && \
    npm run build --workspace=@tillflow/mpesa

FROM deps AS prod-deps
RUN npm ci --workspace=@tillflow/shared --workspace=@tillflow/mpesa --include-workspace-root --omit=dev && \
    mkdir -p services/_shared/mpesa/node_modules

FROM base AS runtime

RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg

ARG COMMIT_SHA=unknown

ENV NODE_ENV=production \
    PORT=9090 \
    COMMIT_SHA=${COMMIT_SHA} \
    SERVICE_NAME=mpesa-stub

COPY --from=prod-deps /app/node_modules ./node_modules/
COPY --from=prod-deps /app/services/_shared/mpesa/node_modules services/_shared/mpesa/node_modules/
COPY --from=build /app/services/_shared/ts/dist services/_shared/ts/dist/
COPY --from=build /app/services/_shared/mpesa/dist services/_shared/mpesa/dist/
COPY services/_shared/ts/package.json services/_shared/ts/package.json
COPY services/_shared/mpesa/package.json services/_shared/mpesa/package.json

WORKDIR /app/services/_shared/mpesa

USER node

EXPOSE 9090

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:9090/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# The entrypoint guard in stub-server.ts matches on argv[1] ending in
# stub-server.js, so this has to be the direct script, not an index re-export.
CMD ["node", "dist/stub-server.js"]
