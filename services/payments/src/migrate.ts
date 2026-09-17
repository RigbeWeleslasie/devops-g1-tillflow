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
/** Which service's secret path to write. Commission shares the payments schema but has its own secret. */
const APP_SERVICE = process.env['APP_SERVICE'] ?? 'payments';
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

    // The app's queries are unqualified (`SELECT ... FROM charges`), so the
    // role needs `payments` on its search_path or every one of them fails with
    // `relation "charges" does not exist`. Postgres defaults a role to
    // `"$user", public`, which contains none of our tables.
    //
    // Set on the ROLE, not just in the connection string, so it holds however
    // the app connects — psql, a hand-built URL, a pooler that resets session
    // state. The URL below carries it too; this failure mode is total and
    // silent-until-runtime, so it is worth both.
    await client.query(
      `ALTER ROLE "${APP_ROLE}" SET search_path TO "${APP_SCHEMA}", public`,
    );

    // Least privilege: CRUD, never DDL, on current and future tables.
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${APP_SCHEMA}" TO "${APP_ROLE}"`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA "${APP_SCHEMA}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${APP_ROLE}"`,
    );

    if (appPassword) {
      if (WRITE_SECRET) {
        await writeAppSecret(appPassword, adminUrl);
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

/**
 * The app's connection URL, built from the admin URL's host/port/database with
 * the app role's own credentials substituted in.
 *
 * search_path rides along in the URL as well as on the role: the app's queries
 * are unqualified, and a connection that lands on the wrong search_path fails
 * every single one of them.
 */
export function buildAppDatabaseUrl(adminUrl: string, password: string): string {
  const admin = new URL(adminUrl);
  const url = new URL(adminUrl);
  url.username = encodeURIComponent(APP_ROLE);
  url.password = encodeURIComponent(password);
  url.search = '';
  url.searchParams.set('options', `-c search_path=${APP_SCHEMA},public`);
  // Keep the admin URL's database and host untouched — same server, same
  // database, different role.
  url.pathname = admin.pathname;
  return url.toString();
}

/**
 * Writes the app credentials to Secrets Manager.
 *
 * BOTH keys, always. `PutSecretValue` replaces the whole document rather than
 * merging, so writing only `{password}` would delete the `database_url` the
 * ECS task definition injects (infra/service-mesh.tf reads
 * `...:database_url::`), and `ignore_changes` on the Terraform placeholder
 * means nothing would put it back. Every service would then fail container
 * start. Writing one key used to be exactly that bug.
 */
async function writeAppSecret(password: string, adminUrl: string): Promise<void> {
  const { SecretsManagerClient, PutSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const region = process.env['AWS_REGION'] ?? 'us-east-1';
  // DB_SECRET_PREFIX is what the migration task passes (infra/migrate.tf);
  // DB_PASSWORD_SECRET_ID stays supported for a hand-run.
  const prefix = process.env['DB_SECRET_PREFIX'] ?? 'devops-g1';
  const secretId = process.env['DB_PASSWORD_SECRET_ID'] ?? `${prefix}/${APP_SERVICE}/db-password`;

  const client = new SecretsManagerClient({ region });
  await client.send(
    new PutSecretValueCommand({
      SecretId: secretId,
      SecretString: JSON.stringify({
        password,
        database_url: buildAppDatabaseUrl(adminUrl, password),
      }),
    }),
  );
  console.log(`Wrote password + database_url to Secrets Manager: ${secretId}`);
}

// Only run when invoked as a program — importing this module (tests) must not
// connect to a database.
if (process.argv[1] && /migrate\.[cm]?[jt]s$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
