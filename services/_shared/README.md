# _shared — shared code

**DRI:** Meron (Platform + delivery); `ts/src/money.ts` and `ts/src/events.ts` co-owned
with Rigbe/Nebyat per `docs/ownership.md` (the two G2 seams both tracks depend on);
`mpesa/` is Nebyat's (ADR 0005).

Shared building blocks used by every service. A change here can rebuild multiple services
(the pipeline treats `_shared` as a dependency of all four).

## Contents

```
_shared/
├─ docker/           # the JS golden-path REFERENCE (G0/G1 platform proof — ECS/ADOT/ALB,
│                     # not meant to be built on for product code)
└─ ts/                # the real shared TypeScript package every service imports as
    ├─ package.json    # @tillflow/shared
    └─ src/
       ├─ money.ts      # integer minor-unit helpers + the one documented rounding rule
       ├─ events.ts      # cross-service event contracts (sale.paid) + the pluggable
       │                 # EventSource<T> interface (real SQS / in-process fake)
       ├─ otel.ts         # OTLP bootstrap -> localhost:4317 (the ADOT sidecar)
       └─ health.ts        # /health /ready /version Fastify plugin
```

> **Note on provenance:** `ts/` was created by Rigbe (not Meron) mid-G2, because it
> blocks Track A and hadn't landed yet — see `docs/scar-log.md`. Meron should review it as
> normal PR content, not rubber-stamp it; the money/events/health pieces are used for real
> by `services/pos/` and `services/web/` (both fully tested against them), but the
> `mpesa/` adapter (Nebyat's, ADR 0005) and any Docker/OTel-collector-config refinements
> Platform wants are still open.

## Golden path (all services inherit)
- Multi-stage Docker, base image pinned by digest, non-root user, read-only root filesystem
  — `docker/Dockerfile` is the reference; `services/pos/Dockerfile` and
  `services/web/Dockerfile` adapt it for an npm-workspaces TypeScript build (repo-root
  build context, since they depend on `@tillflow/shared`).
- `/health` (liveness), `/ready` (readiness), `/version` (`{sha,digest}`) — `ts/src/health.ts`
- JSON logs with `trace_id` / `span_id` (via Fastify's request logger once the OTel context
  propagates); OTLP → `localhost:4317` — `ts/src/otel.ts`
- OTel resource attributes: `service.name`, `service.version` (=SHA), `deployment.environment`

## Using it from a service

```bash
npm install            # from the repo root — npm workspaces resolve @tillflow/shared locally
```
```ts
import { toMinorUnits, commissionForSale } from '@tillflow/shared/money';
import { isSalePaidEvent, type SalePaidEvent } from '@tillflow/shared/events';
import { startTelemetry } from '@tillflow/shared/otel';
import { healthPlugin } from '@tillflow/shared/health';
```

See `services/_shared/ts/test/money.test.ts` for the money rounding-rule tests (9 passing).
