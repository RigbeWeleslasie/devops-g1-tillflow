# ADR 0001 — Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-09-09
- **DRI:** Meron (Platform + delivery)

## Context

The capstone requires critical decisions to be recorded as ADRs before G1, with a named
DRI per decision. We need a consistent, lightweight format.

## Decision

We use Markdown ADRs numbered sequentially in `docs/adr/NNNN-title.md`. Each ADR has:
Status, Date, DRI, Context, Decision, Consequences, and (where relevant) Required proof.

Statuses: `Proposed` → `Accepted` → `Superseded by NNNN` / `Deprecated`.

ADRs are immutable once Accepted; a change is a new ADR that supersedes the old one.

## Consequences

- Reviewers can find the "why" behind every non-obvious choice.
- The DRI ledger in `docs/ownership.md` links to these files.
- Overhead is one short file per decision.
