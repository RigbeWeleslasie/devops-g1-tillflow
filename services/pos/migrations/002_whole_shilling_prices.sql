-- M-Pesa bills whole shillings; both adapters refuse a fractional amount
-- rather than rounding it (ADR 0005). Enforced at the application layer
-- already (tenantService.createProduct rejects a non-multiple-of-100 price
-- before the INSERT), and mirrored here at the DB layer as defense in
-- depth -- against a direct write that bypasses the app, not as the primary
-- gate.
--
-- This is a NEW migration, not an edit to 001_init.sql. 001 briefly carried
-- this inline; that edit never reaches any database that already ran the
-- original 001, because scripts/migrate.ts tracks applied files by name
-- (see docs/scar-log.md). Applied migrations are immutable from here on --
-- any further schema change is a new numbered file, no exceptions.
--
-- Before running against a database that already has rows: any existing
-- product/sale_item priced in fractional shillings will make this ALTER
-- fail outright (Postgres validates existing rows against a new CHECK
-- constraint by default). Fix or remove those rows first, or add the
-- constraint NOT VALID and VALIDATE it separately once the data is clean.

ALTER TABLE products
  ADD CONSTRAINT products_whole_shillings CHECK (mod(unit_price_minor, 100) = 0);

ALTER TABLE sale_items
  ADD CONSTRAINT sale_items_whole_shillings CHECK (mod(unit_price_minor, 100) = 0);
