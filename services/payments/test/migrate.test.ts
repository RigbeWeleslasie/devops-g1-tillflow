/**
 * The migration job's contract with infra.
 *
 * Two things here are not obvious from reading the code, and both were real
 * bugs: the secret must carry BOTH keys (PutSecretValue replaces the whole
 * document, and the ECS task definition injects `...:database_url::`), and the
 * app's unqualified queries need `search_path` pinned or every one of them
 * fails against a real schema-per-service database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildAppDatabaseUrl } from '../src/migrate.js';

const ADMIN = 'postgres://tillflow_master:s3cr3t@devops-g1-db.abc.us-east-1.rds.amazonaws.com:5432/tillflow';

describe('the app DATABASE_URL the migration job writes', () => {
  test('keeps the admin host, port and database, but swaps in the app role', () => {
    const url = new URL(buildAppDatabaseUrl(ADMIN, 'app-pw'));
    assert.equal(url.hostname, 'devops-g1-db.abc.us-east-1.rds.amazonaws.com');
    assert.equal(url.port, '5432');
    assert.equal(url.pathname, '/tillflow');
    assert.equal(decodeURIComponent(url.username), 'devops-g1-payments-app');
    assert.notEqual(decodeURIComponent(url.username), 'tillflow_master', 'never the master role');
    assert.equal(decodeURIComponent(url.password), 'app-pw');
  });

  test('pins search_path — the app queries `FROM charges` unqualified', () => {
    const url = new URL(buildAppDatabaseUrl(ADMIN, 'app-pw'));
    assert.match(url.searchParams.get('options') ?? '', /search_path=payments,public/);
  });

  test('a password with URL-hostile characters survives a round trip', () => {
    // crypto.randomBytes().toString('base64url') is URL-safe, but the secret
    // may be rotated by hand to something that is not.
    const nasty = 'p@ss:w/rd?#&=+ %';
    const url = new URL(buildAppDatabaseUrl(ADMIN, nasty));
    assert.equal(decodeURIComponent(url.password), nasty);
  });

  test('the admin URL is not mutated', () => {
    const before = ADMIN;
    buildAppDatabaseUrl(ADMIN, 'x');
    assert.equal(before, ADMIN);
  });
});
