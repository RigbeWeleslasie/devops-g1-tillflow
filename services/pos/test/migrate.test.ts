/**
 * The migration job's contract with infra. Mirrors
 * services/payments/test/migrate.test.ts — the two must behave identically or
 * one ECS migration task cannot cover both services.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildAppDatabaseUrl } from '../src/migrate.js';

const ADMIN = 'postgres://tillflow_master:s3cr3t@devops-g1-db.abc.us-east-1.rds.amazonaws.com:5432/tillflow';

describe('the app DATABASE_URL the POS migration job writes', () => {
  test('keeps the admin host, port and database, but swaps in the app role', () => {
    const url = new URL(buildAppDatabaseUrl(ADMIN, 'app-pw'));
    assert.equal(url.hostname, 'devops-g1-db.abc.us-east-1.rds.amazonaws.com');
    assert.equal(url.port, '5432');
    assert.equal(url.pathname, '/tillflow');
    assert.equal(decodeURIComponent(url.username), 'devops-g1-pos-app');
    assert.notEqual(decodeURIComponent(url.username), 'tillflow_master', 'never the master role');
  });

  test('pins search_path to the pos schema — the app queries `FROM sales` unqualified', () => {
    const url = new URL(buildAppDatabaseUrl(ADMIN, 'app-pw'));
    assert.match(url.searchParams.get('options') ?? '', /search_path=pos,public/);
  });

  test('a password with URL-hostile characters survives a round trip', () => {
    const nasty = 'p@ss:w/rd?#&=+ %';
    assert.equal(decodeURIComponent(new URL(buildAppDatabaseUrl(ADMIN, nasty)).password), nasty);
  });
});
