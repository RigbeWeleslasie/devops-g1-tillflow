# _shared — shared code

**DRI:** Meron (Platform + delivery); `mpesa/` interface co-owned with Nebyat.

Shared building blocks used by every service. A change here can rebuild multiple services
(the pipeline treats `_shared` as a dependency of all four).

## Contents (created in G1)
```
_shared/
├─ mpesa/            # MpesaAdapter interface, DarajaAdapter, FakeAdapter, stub-server
│                    # ADR 0005 — deterministic scenario table lives here
├─ otel/             # OTLP/ADOT setup, JSON log formatter with trace_id/span_id
├─ docker/           # multi-stage base image: pinned digest, non-root, read-only rootfs
│                    # standard /health /ready /version wiring
├─ money/            # integer minor-unit helpers, documented rounding
└─ types/            # shared request/response + event schemas (sale.paid, payout.*)
```

## Golden path (all services inherit)
- Multi-stage Docker, base image pinned by digest, non-root user, read-only root filesystem
- `/health` (liveness), `/ready` (readiness), `/version` (`{sha,digest}`)
- JSON logs with `trace_id` / `span_id`; OTLP → `localhost:4317`
- OTel resource attributes: `service.name`, `service.version` (=SHA), `deployment.environment`
