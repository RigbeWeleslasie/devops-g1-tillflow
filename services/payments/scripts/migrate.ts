#!/usr/bin/env node
/**
 * Payments migration runner — the "migration job" infra/secrets.tf refers to
 * for the `payments` schema. Same pattern as services/pos/scripts/migrate.ts
 * (Rigbe's), parameterised for this schema; kept per-service rather than
 * shared so each service stays independently deployable.
 *
 * Creates the `payments` schema + the `devops-g1-payments-app` least-privilege
 * role (ADR 0003), applies migrations/*.sql in order, and (optionally) writes
 * the generated app password to Secrets Manager at
 * `devops-g1/payments/db-password`. The commission worker shares this schema
 * and role (docs/architecture.md §3), so this one job covers both services.
 *
 * Credential scopes:
 *   - ADMIN_DATABASE_URL: RDS master creds (the devops-g1/db secret). Only
 *     this script ever uses them, only for DDL + grants.
 *   - The apps connect as devops-g1-payments-app and never see the master
 *     password.
 *
 * Usage:
 *   ADMIN_DATABASE_URL=postgres://... npx tsx scripts/migrate.ts
 *   ADMIN_DATABASE_URL=postgres://... npx tsx scripts/migrate.ts --write-secret
 */
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

const APP_SCHEMA = process.env['APP_SCHEMA'] ?? 'payments';
const APP_ROLE = process.env['APP_ROLE'] ?? 'devops-g1-payments-app';
const WRITE_SECRET = process.argv.includes('--write-secret');

async function main(): Promise<void> {
  const adminUrl = process.env['ADMIN_DATABASE_URL'];
  if (!adminUrl) {
    console.error('ADMIN_DATABASE_URL is required (RDS master credentials).');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();

  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${APP_SCHEMA}"`);

    const roleExists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);

    // Identifiers can't be parameterised; APP_ROLE/APP_SCHEMA are env/defaults
    // we control, not user input.
    let appPassword: string | undefined;
    if (roleExists.rowCount === 0) {
      appPassword = crypto.randomBytes(24).toString('base64url');
      await client.query(
        `CREATE ROLE "${APP_ROLE}" WITH LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}'`,
      );
      console.log(`Created role ${APP_ROLE}.`);
    } else {
      console.log(`Role ${APP_ROLE} already exists; leaving its password as-is.`);
    }

    await client.query(`GRANT USAGE ON SCHEMA "${APP_SCHEMA}" TO "${APP_ROLE}"`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "${APP_SCHEMA}".schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const applied = await client.query(`SELECT filename FROM "${APP_SCHEMA}".schema_migrations`);
    const appliedSet = new Set(applied.rows.map((r: { filename: string }) => r.filename));

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    await client.query(`SET search_path TO "${APP_SCHEMA}"`);

    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`skip  ${file} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`apply ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO "${APP_SCHEMA}".schema_migrations (filename) VALUES ($1)`, [
          file,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    // Least privilege: CRUD, never DDL, on current and future tables.
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${APP_SCHEMA}" TO "${APP_ROLE}"`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA "${APP_SCHEMA}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${APP_ROLE}"`,
    );

    if (appPassword) {
      if (WRITE_SECRET) {
        await writeSecretPassword(appPassword);
      } else {
        console.log('');
        console.log('Generated app password (save this now -- it is never printed again):');
        console.log(appPassword);
        console.log('');
        console.log(
          'Set it at devops-g1/payments/db-password, or re-run with --write-secret to do that automatically.',
        );
      }
    }

    console.log('Migration complete.');
  } finally {
    await client.end();
  }
}

async function writeSecretPassword(password: string): Promise<void> {
  const { SecretsManagerClient, PutSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const region = process.env['AWS_REGION'] ?? 'us-east-1';
  const secretId = process.env['DB_PASSWORD_SECRET_ID'] ?? 'devops-g1/payments/db-password';
  const client = new SecretsManagerClient({ region });
  await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: JSON.stringify({ password }) }));
  console.log(`Wrote the app password to Secrets Manager: ${secretId}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
