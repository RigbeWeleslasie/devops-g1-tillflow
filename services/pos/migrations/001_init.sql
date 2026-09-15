-- POS schema — devops-g1 / TillFlow
-- DRI: Rigbe (Product + POS). See docs/adr/0007-sale-idempotency.md.
--
-- Runs inside the `pos` schema (created by the migration runner before this
-- file, per ADR 0003: one schema + one least-privilege role per service).
--
-- IDs are application-generated UUIDs (crypto.randomUUID() in src/db.ts),
-- not gen_random_uuid() defaults -- keeps the schema portable across a real
-- Postgres and the pg-mem in-memory engine the test suite runs against,
-- without depending on the pgcrypto extension either way.

CREATE TABLE tenants (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  till_number TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Owner + attendant identities, scoped to a tenant. external_auth_id is the
-- identity-provider subject; G2 has no login flow of its own (out of scope --
-- see services/pos/README.md), so dev-mode auth mints a token directly for
-- a known (tenant_id, external_auth_id) pair.
CREATE TABLE users (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  external_auth_id  TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('owner', 'attendant')),
  display_name      TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_auth_id)
);

CREATE INDEX idx_users_tenant ON users (tenant_id);

-- A thin profile beyond `users`: the payout MSISDN. Owner-managed only
-- (threat-model.md A7 -- B2C must never take a phone number from the
-- attendant's own request).
CREATE TABLE attendants (
  id         UUID PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  user_id    UUID NOT NULL REFERENCES users(id),
  msisdn     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX idx_attendants_tenant ON attendants (tenant_id);

-- attendant_id NULL = the tenant's default rate. Commission snapshots the
-- rate into the payout ledger at compute time (payments_payout_ledger,
-- Nebyat's schema) -- this table is the current rate, not history.
CREATE TABLE commission_rates (
  id             UUID PRIMARY KEY,
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  attendant_id   UUID REFERENCES attendants(id),
  rate_bps       INT NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_commission_rates_tenant ON commission_rates (tenant_id);

CREATE TABLE products (
  id               UUID PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id),
  name             TEXT NOT NULL,
  unit_price_minor INT NOT NULL CHECK (unit_price_minor >= 0),
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_products_tenant ON products (tenant_id);

-- Sale state machine: DRAFT -> OPEN -> UNPAID -> PAID, VOID from OPEN/UNPAID.
-- G2 scope creates sales directly at UNPAID (all line items supplied
-- up-front via POST /sales) -- DRAFT/OPEN exist in the enum for the richer
-- staged-entry flow docs/adr/0007 describes, not yet wired to an endpoint.
-- PAID is set ONLY by the sale.paid consumer (src/workers/salePaidConsumer.ts),
-- never by an API handler directly.
CREATE TABLE sales (
  id           UUID PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  attendant_id UUID NOT NULL REFERENCES attendants(id),
  status       TEXT NOT NULL CHECK (status IN ('DRAFT', 'OPEN', 'UNPAID', 'PAID', 'VOID')),
  total_minor  INT NOT NULL CHECK (total_minor >= 0),
  charge_id    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at      TIMESTAMPTZ
);

CREATE INDEX idx_sales_tenant ON sales (tenant_id);
CREATE INDEX idx_sales_tenant_status ON sales (tenant_id, status);

-- unit_price_minor is snapshotted at add-time (a later product price change
-- must not reprice a sale that already happened).
CREATE TABLE sale_items (
  id               UUID PRIMARY KEY,
  sale_id          UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id       UUID NOT NULL REFERENCES products(id),
  quantity         INT NOT NULL CHECK (quantity > 0),
  unit_price_minor INT NOT NULL CHECK (unit_price_minor >= 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sale_items_sale ON sale_items (sale_id);

-- I1: one sale per (tenant, idempotency key). request_hash catches key reuse
-- with a different body (-> 409); a matching hash replays response_body
-- verbatim rather than re-running the handler. response_body/status are the
-- exact bytes/code returned the first time, so a replay is byte-identical.
CREATE TABLE idempotency_keys (
  tenant_id        UUID NOT NULL REFERENCES tenants(id),
  idempotency_key  TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  sale_id          UUID NOT NULL REFERENCES sales(id),
  response_status  INT NOT NULL,
  response_body    TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key)
);

-- sale.paid is idempotent on sale_id (the contract, docs/architecture.md
-- §4.1): this table is what makes a redelivered or duplicated event a no-op
-- rather than a second PAID transition.
CREATE TABLE sale_paid_events (
  sale_id    UUID PRIMARY KEY REFERENCES sales(id),
  event_id   TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
