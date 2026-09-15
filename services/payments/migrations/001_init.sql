-- Payments schema — devops-g1 / TillFlow
-- DRI: Nebyat (Payments + integrity). See docs/adr/0006-idempotency-and-replay.md.
--
-- Runs inside the `payments` schema (created by scripts/migrate.ts before this
-- file, per ADR 0003: one schema + one least-privilege role per service). The
-- commission worker shares this schema and role — the payout ledger is an
-- integrity concern owned here (docs/architecture.md §3).
--
-- IDs are application-generated UUIDs, matching services/pos: keeps the SQL
-- portable between real Postgres and the pg-mem engine the test suite runs
-- against, with no dependency on pgcrypto.
--
-- Money is integer minor units (KES cents) everywhere. M-Pesa itself bills
-- whole shillings, so anything that goes to Daraja carries a `mod(x, 100) = 0` check.

-- ---------------------------------------------------------------------------
-- charges — one per sale (I2). The STK Push state machine.
--
--   PENDING -> PAID     (callback / query ResultCode 0)
--   PENDING -> FAILED   (callback / query with a definite decline)
--   PAID, FAILED are terminal. There is NO transition on a timeout: a push that
--   times out leaves the row PENDING with checkout_request_id NULL (I5).
-- ---------------------------------------------------------------------------
CREATE TABLE charges (
  id                   UUID PRIMARY KEY,
  sale_id              UUID NOT NULL UNIQUE,           -- I2: one charge per sale, ever
  tenant_id            UUID NOT NULL,
  amount_minor         INT NOT NULL CHECK (amount_minor > 0 AND mod(amount_minor, 100) = 0),
  till                 TEXT NOT NULL,
  customer_msisdn      TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('PENDING', 'PAID', 'FAILED')),
  -- Set when Daraja acks the push. NULL after a timeout: we never heard back.
  merchant_request_id  TEXT,
  checkout_request_id  TEXT UNIQUE,
  stk_attempts         INT NOT NULL DEFAULT 0,
  last_push_error      TEXT,
  -- Terminal detail, from whichever of callback / query resolved it.
  mpesa_receipt        TEXT,
  result_code          INT,
  result_desc          TEXT,
  resolved_by          TEXT CHECK (resolved_by IS NULL OR resolved_by IN ('callback', 'query')),
  -- Reconciler bookkeeping (I5): how many times stkQuery has been asked.
  reconcile_attempts   INT NOT NULL DEFAULT 0,
  last_reconciled_at   TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at              TIMESTAMPTZ,
  failed_at            TIMESTAMPTZ
);

CREATE INDEX idx_charges_tenant ON charges (tenant_id);
CREATE INDEX idx_charges_status_created ON charges (status, created_at);

-- ---------------------------------------------------------------------------
-- callback_events — every inbound Daraja callback, deduplicated (I3).
--
-- Inserted in the SAME transaction as the state transition it drives. The
-- unique key is the ADR's (reference, result_code, checksum): an identical
-- redelivery collides here and bumps duplicate_count instead of re-applying
-- anything. `matched` and `applied` are the audit trail a trace points at:
-- "second span, zero writes" is a row with duplicate_count > 0.
-- ---------------------------------------------------------------------------
CREATE TABLE callback_events (
  id               UUID PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('stk', 'b2c')),
  -- CheckoutRequestID (stk) or ConversationID (b2c).
  reference        TEXT NOT NULL,
  result_code      INT NOT NULL,
  -- sha256 of the canonicalised body: same bytes, same row.
  checksum         TEXT NOT NULL,
  -- Did the reference map to a charge/payout we issued? An unmatched callback
  -- is stored (never dropped) and alerted on, but applies nothing.
  matched          BOOLEAN NOT NULL,
  -- Did this delivery cause a state transition? false for a duplicate, an
  -- unmatched reference, or a row that was already terminal.
  applied          BOOLEAN NOT NULL,
  duplicate_count  INT NOT NULL DEFAULT 0,
  body             JSONB NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, reference, result_code, checksum)
);

CREATE INDEX idx_callback_events_reference ON callback_events (kind, reference);

-- ---------------------------------------------------------------------------
-- outbox_events — the "one ledger effect" of a PAID transition (I3).
--
-- The sale.paid event is a ROW written in the same transaction as the
-- PENDING -> PAID update, and published to SQS afterwards by a relay
-- (src/outbox). There is no window where the charge is PAID but the event
-- was never recorded. UNIQUE(event_type, aggregate_id) is the database's own
-- guarantee of exactly one effect per charge, however many callbacks arrive.
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_events (
  id                UUID PRIMARY KEY,
  event_type        TEXT NOT NULL,
  aggregate_id      UUID NOT NULL,
  payload           JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at      TIMESTAMPTZ,
  publish_attempts  INT NOT NULL DEFAULT 0,
  last_error        TEXT,
  UNIQUE (event_type, aggregate_id)
);

CREATE INDEX idx_outbox_unpublished ON outbox_events (published_at, created_at);

-- ---------------------------------------------------------------------------
-- payout_ledger — one per (tenant, attendant, business day) (I4).
--
-- Written by the commission worker with INSERT ... ON CONFLICT DO NOTHING:
-- a re-run of the close for the same day finds the row already there and
-- does nothing. The rate and MSISDN are SNAPSHOTS taken at compute time
-- (threat-model.md A5/A7): a later rate edit or phone change cannot alter a
-- payout that was already computed.
--
-- amount_minor is the exact commission (sum over sales of
-- floor(sale_total_minor * rate_bps / 10000), the single rounding rule in
-- @tillflow/shared/money). M-Pesa B2C pays whole shillings, so payout_minor
-- is amount_minor floored to a whole shilling and remainder_minor is the
-- cents that stay with the tenant. Both are recorded so the truncation is
-- auditable, not silent.
--
--   COMPUTED  -> REQUESTED   (Payments API accepted the payout)
--   REQUESTED -> PAID | FAILED  (mirrors the payout's terminal state)
--   COMPUTED  -> SKIPPED     (payout_minor = 0: nothing to send)
-- ---------------------------------------------------------------------------
CREATE TABLE payout_ledger (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL,
  attendant_id      UUID NOT NULL,
  business_day      DATE NOT NULL,
  amount_minor      INT NOT NULL CHECK (amount_minor >= 0),
  payout_minor      INT NOT NULL CHECK (payout_minor >= 0 AND mod(payout_minor, 100) = 0),
  remainder_minor   INT NOT NULL CHECK (remainder_minor >= 0 AND remainder_minor < 100),
  rate_bps          INT NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  msisdn            TEXT NOT NULL,
  sale_count        INT NOT NULL CHECK (sale_count >= 0),
  sale_total_minor  INT NOT NULL CHECK (sale_total_minor >= 0),
  status            TEXT NOT NULL CHECK (status IN ('COMPUTED', 'REQUESTED', 'PAID', 'FAILED', 'SKIPPED')),
  close_run_id      UUID,
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, attendant_id, business_day)                      -- I4
);

CREATE INDEX idx_payout_ledger_day ON payout_ledger (business_day);
CREATE INDEX idx_payout_ledger_tenant ON payout_ledger (tenant_id, business_day);

-- ---------------------------------------------------------------------------
-- payouts — one per ledger row (I4). The B2C state machine.
--
--   PENDING -> PAID | FAILED. Terminal. No transition on timeout (I5).
--
-- originator_conversation_id is the ledger id: Daraja echoes it back on the
-- result, which is how a B2C callback finds its row without depending on
-- ConversationID (assigned by Daraja, and absent after a timeout).
-- ---------------------------------------------------------------------------
CREATE TABLE payouts (
  id                          UUID PRIMARY KEY,
  ledger_id                   UUID NOT NULL UNIQUE REFERENCES payout_ledger(id),  -- I4
  tenant_id                   UUID NOT NULL,
  amount_minor                INT NOT NULL CHECK (amount_minor > 0 AND mod(amount_minor, 100) = 0),
  msisdn                      TEXT NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN ('PENDING', 'PAID', 'FAILED')),
  originator_conversation_id  TEXT NOT NULL UNIQUE,
  conversation_id             TEXT UNIQUE,
  b2c_attempts                INT NOT NULL DEFAULT 0,
  last_request_error          TEXT,
  transaction_id              TEXT,
  result_code                 INT,
  result_desc                 TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at                     TIMESTAMPTZ,
  failed_at                   TIMESTAMPTZ
);

CREATE INDEX idx_payouts_status_created ON payouts (status, created_at);

-- ---------------------------------------------------------------------------
-- close_runs — one per daily-close execution, for the Commission SLI
-- ("eligible payouts terminal by 06:30 EAT") and for replay evidence: a
-- re-run shows ledger_rows_created = 0 and ledger_rows_existing = N.
-- ---------------------------------------------------------------------------
CREATE TABLE close_runs (
  id                     UUID PRIMARY KEY,
  business_day           DATE NOT NULL,
  trigger_source         TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  tenants_processed      INT NOT NULL DEFAULT 0,
  ledger_rows_created    INT NOT NULL DEFAULT 0,
  ledger_rows_existing   INT NOT NULL DEFAULT 0,
  payouts_requested      INT NOT NULL DEFAULT 0,
  error                  TEXT,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at            TIMESTAMPTZ
);

CREATE INDEX idx_close_runs_day ON close_runs (business_day, started_at);
