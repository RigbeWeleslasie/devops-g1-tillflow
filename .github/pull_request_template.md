<!-- Title: <area>: <what changed> -->

## What & why

<!-- One paragraph. Link the ADR / issue / gate this advances. -->

## Area & ownership

- [ ] I am the DRI for the changed path, **or** the DRI has approved
- Area: <!-- Product+POS / Payments+integrity / Platform+delivery / Reliability+ops -->
- Cross-reviewer requested: <!-- @handle of the other-area reviewer -->

## Gate

- Advances: <!-- G0 / G1 / G2 / G3 / G4 / G5 -->

## Checklist

- [ ] Tests added/updated (unit / integration / contract / replay as relevant)
- [ ] No secrets, credentials, or real customer data in the diff
- [ ] Money stays in integer minor units
- [ ] Resource names prefixed `devops-g1-`; required tags present (infra changes)
- [ ] Docs updated (ADR / runbook / ownership / SLO) if behavior or decisions changed
- [ ] `terraform plan` output attached (infra changes)

## Evidence

<!-- Link to evidence/<area>/ additions: commands to reproduce, runtime proof. -->
