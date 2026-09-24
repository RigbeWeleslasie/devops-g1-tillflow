# G3 traces — captured, real, end to end (OTLP → ADOT → X-Ray)

**DRI:** Rigbe (`docs/ownership.md`'s "Telemetry (spans/metrics/logs)" row). See
`docs/gates.md`'s G3 checklist for the full story of what it took to get here — this file
is the artifact, that section is the narrative.

## What was captured

A real `POST /api/pos/tenants` request against the deployed edge (2026-09-24, ~15:41 UTC)
produced trace **`1-98771370-d73ccb29281626cea3fd08b9`**, read via `aws xray
get-trace-summaries` / `batch-get-traces` under the `devops-g1` SSO profile, then viewed in
the AWS X-Ray console (CloudWatch → X-Ray → Traces) and screenshotted:
[`g3-trace-capture.png`](g3-trace-capture.png).

The waterfall, exactly as `docs/architecture.md`'s "Span boundaries: inbound HTTP, DB
query..." describes:

| Span | Duration |
| --- | --- |
| `pos` — `POST /api/pos/tenants` → **201** | 52ms |
| `pg-pool.connect` | 35ms |
| &nbsp;&nbsp;`pg.connect` | 31ms |
| &nbsp;&nbsp;&nbsp;&nbsp;`tcp.connect` | 3ms |
| &nbsp;&nbsp;&nbsp;&nbsp;`dns.lookup` | 2ms |
| `pg.query:BEGIN tillflow` | 3ms |
| `pg.query:INSERT tillflow` | 3ms |
| `pg.query:INSERT tillflow` | 3ms |
| `pg.query:COMMIT tillflow` | 2ms |

Two `INSERT`s + one transaction match `POST /tenants` creating both a `tenants` row and an
`owner` (attendant) row inside one transaction — real application behavior visible in the
trace, not a synthetic health-check ping. (An earlier, thinner capture off `GET /ready` is
what the branch's history shows first — this replaced it with the real DB-backed request.)

## The path that got here — worth recording, not just the result

The originally planned path (Grafana → Explore → X-Ray data source) turned out to be
blocked by real, previously-undocumented infrastructure facts, each one confirmed by
actually trying it rather than assumed:

1. Amazon Managed Grafana gates **all** plugin installs — even AWS's own X-Ray data
   source, published by Grafana Labs — behind a workspace-level **"Plugin management"**
   setting, separate from Grafana's own RBAC (a confirmed org Admin still hit "You do not
   have permission to install this plugin") and separate from the `data_sources` list
   already declared in Terraform.
2. That setting isn't a Terraform-exposed argument on `aws_grafana_workspace`, so it needed
   a direct API call: `aws grafana update-workspace-configuration --workspace-id
   g-abb9c4666f --configuration '{"unifiedAlerting":{"enabled":false},"plugins":
   {"pluginAdminEnabled":true}}'` — same pattern as the `pos-worker` service cutover
   earlier in this project (`docs/scar-log.md`). Rigbe's own `devops-g1` SSO permissions
   were already sufficient; no other DRI's action was needed.
3. Once installed, the X-Ray data source's own config editor in this Grafana
   version/workspace combination failed to render (empty Settings page, reproducible
   after a delete-and-recreate) — a plugin bug, not a permissions issue.
4. Rather than keep debugging a UI plugin bug, switched to the **native AWS X-Ray
   console** (`CloudWatch → X-Ray`), which needs no Grafana plugin at all and worked
   immediately — the same underlying trace data, read a different way. `docs/runbook.md`'s
   documented workflow ("Grafana → X-Ray data source, filter by trace_id") is still the
   intended path once the plugin bug is sorted; this capture proves the pipeline itself
   (ADOT → X-Ray → readable trace) works end to end regardless of which UI reads it.

## What this proves and what it doesn't

- **Proves:** the ADOT sidecar really exports spans (`infra/ecs.tf`'s `awsxray` exporter),
  they really land in X-Ray, and they're really readable with the IAM permissions already
  granted — the full pipeline, not just the Terraform declaring it should work.
- **Doesn't prove:** the Grafana-side trace workflow (`docs/runbook.md`'s "pull `trace_id`
  from an alert, open it in Grafana") — that's still blocked on the plugin bug in point 3
  above. Worth a fresh look once this plugin ships a fix, or trying the same data source
  under a different name/version.
