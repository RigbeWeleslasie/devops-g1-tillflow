/**
 * POST /payouts and the B2C result callback — I4's second half (one payout
 * per ledger row, duplicate disbursement = 0) and I5 on the payout side.
 *
 * The ledger rows here are inserted directly, standing in for what the
 * commission worker will write in commit 8. What is under test is the money
 * movement, not how the amount was computed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { B2C_RESULT, type B2CResultBody } from '@tillflow/mpesa';
import { createHarness, countRows, type Harness } from './harness.js';

const DAY = '2026-09-14';

/** A COMPUTED ledger row. payoutMinor drives the fake's scenario (KES 1 500 = success). */
async function seedLedger(
  h: Harness,
  opts: { payoutMinor?: number; msisdn?: string; tenantId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const payoutMinor = opts.payoutMinor ?? 150_000;
  await h.db.query(
    `INSERT INTO payout_ledger (id, tenant_id, attendant_id, business_day, amount_minor, payout_minor, remainder_minor,
                                rate_bps, msisdn, sale_count, sale_total_minor, status)
     VALUES ($1, $2, $3, $4, $5, $5, 0, 500, $6, 3, 3000000, 'COMPUTED')`,
    [id, opts.tenantId ?? randomUUID(), randomUUID(), DAY, payoutMinor, opts.msisdn ?? '254700000000'],
  );
  return id;
}

async function payoutRow(h: Harness, ledgerId: string) {
  const r = await h.db.query('SELECT * FROM payouts WHERE ledger_id = $1', [ledgerId]);
  return r.rows[0]!;
}

async function ledgerRow(h: Harness, ledgerId: string) {
  const r = await h.db.query('SELECT * FROM payout_ledger WHERE id = $1', [ledgerId]);
  return r.rows[0]!;
}

describe('POST /payouts — happy path', () => {
  test('creates a PENDING payout, sends B2C once, marks the ledger REQUESTED', async () => {
    const h = await createHarness();
    const ledgerId = await seedLedger(h);

    const res = await h.call({ method: 'POST', url: '/payouts', payload: { ledgerId } });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().status, 'PENDING');
    assert.equal(res.json().created, true);
    assert.match(res.json().conversationId, /^AG_fake_/);

    const p = await payoutRow(h, ledgerId);
    assert.equal(p.b2c_attempts, 1);
    assert.equal(p.originator_conversation_id, p.id, 'our payout id IS the originator reference');
    assert.equal((await ledgerRow(h, ledgerId)).status, 'REQUESTED');
    assert.equal(h.fake.peekPending().length, 1);
    await h.close();
  });
});

describe('I4 — one payout per ledger row', () => {
  test('a repeat POST for the same ledgerId returns the same payout and sends NOTHING', async () => {
    const h = await createHarness();
    const ledgerId = await seedLedger(h);

    const first = await h.call({ method: 'POST', url: '/payouts', payload: { ledgerId } });
    const second = await h.call({ method: 'POST', url: '/payouts', payload: { ledgerId } });

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().payoutId, first.json().payoutId);
    assert.equal(second.json().created, false);

    assert.equal(await countRows(h.db, 'payouts'), 1);
    assert.equal(h.fake.peekPending().length, 1, 'ONE disbursement, not two');
    assert.equal((await payoutRow(h, ledgerId)).b2c_attempts, 1);
    await h.close();
  });

  test('concurrent POSTs for the same ledgerId converge on one payout and one send', async () => {
    const h = await createHarness();
    const ledgerId = await seedLedger(h);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => h.call({ method: 'POST', url: '/payouts', payload: { ledgerId } })),
    );
    assert.equal(new Set(results.map((r) => r.json().payoutId)).size, 1);
    assert.equal(results.filter((r) => r.statusCode === 201).length, 1);
    assert.equal(await countRows(h.db, 'payouts'), 1);
    assert.equal(h.fake.peekPending().length, 1, 'duplicate disbursement = 0');
    await h.close();
  });

  test('a repeat AFTER the payout is already PAID still sends nothing', async () => {
    const h = await createHarness();
    const ledgerId = await seedLedger(h);
    await h.call({ method: 'POST', url: '/payouts', payload: { ledgerId } });
    await h.fake.deliverPending();
    assert.equal((await payoutRow(h, ledgerId)).status, 'PAID');

    const retry = await h.call({ method: 'POST', url: '/payouts', payload: { ledgerId } });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().status, 'PAID');
    assert.equal(await countRows(h.db, 'payouts'), 1);
    assert.equal(h.fake.deliveredCallbacks().length, 1);
    await h.close();
  });
});

describe('I5 on the payout side', () => {
  test('a timed-out B2C request leaves the payout PENDING, never FAILED, and nothing re-sends', async () => {
    const h = await createHarness();
    const ledgerId = await seedLedger(h, { payoutMinor: 10_300 }); // KES 103: timeout

    const res = await h.call({ method: 'POST', url: '/payouts', payload: { ledgerId } });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().status, 'PENDING');
    assert.equal(res.json().conversationId, null, 'we never heard back');

    const p = await payoutRow(h, ledgerId);
    assert.equal(p.status, 'PENDING');
    assert.equal(p.failed_at, null);
    assert.match(p.last_request_error, /MpesaTimeoutError/);

    // A retry is safe and must still not re-send: this is how someone gets
    // paid twice.
    const retry = await h.call({ method: 'POST', url: '/payouts', payload: { ledgerId } });
    assert.equal(retry.json().status, 'PENDING');
    assert.equal((await payoutRow(h, ledgerId)).b2c_attempts, 1);
    await h.close();
  });

  test('the b2c-timeout notice does not fail the payout', async () => {
    const h = await createHarness();
    const ledgerId = await seedLedger(h, { payoutMinor: 10_300 });
    await h.call({ method: 'POST', url: '/payouts', payload: { ledgerId } });

    const res = await h.app.inject({
      method: 'POST',
      url: '/callbacks/b2c-timeout',
      payload: { Result: { ResultCode: 1, ResultDesc: 'queue timeout' } },
    });
    assert.equal(res.statusCode, 200);
    assert.equal((await payoutRow(h, ledgerId)).status, 'PENDING');
    await h.close();
  });
});

describe('B2C result callbacks — I3 on the payout side', () => {
  test('success: payout PAID and the ledger row PAID, in one transaction', async () => {
    const h = await createHarness();
    const ledgerId = await seedLedger(h);
    await h.call({ method: 'POST', url: '/payouts', payload: { ledgerId } });

    await h.fake.deliverPending();

    const p = await payoutRow(h, ledgerId);
    assert.equal(p.status, 'PAID');
    assert.match(p.transaction_id, /^FAKEB2C/);
    assert.equal(p.result_code, B2C_RESULT.SUCCESS);
    assert.ok(p.paid_at);
    assert.equal((await ledgerRow(h, ledgerId)).status, 'PAID');
    await h.close();
  });

  test('insufficient balance: payout FAILED and the ledger row FAILED', async () => {
    const h = await createHarness();
    const ledgerId = await seedLedger(h, { payoutMinor: 10_200 }); // KES 102
    await h.call({ method: 'POST', url: '/payouts', payload: { ledgerId } });

    await h.fake.deliverPending();

    assert.equal((await payoutRow(h, ledgerId)).status, 'FAILED');
    assert.equal((await ledgerRow(h, ledgerId)).status, 'FAILED');
    await h.close();
  });

  test('an identical redelivery is deduped: one row, one transition', async () => {
    const h = await createHarness();
    const ledgerId = await seedLedger(h);
    await h.call({ method: 'POST', url: '/payouts', payload: { ledgerId } });
    await h.fake.deliverPending();
    const first = h.fake.deliveredCallbacks()[0]!;

    await h.fake.redeliver(first);
    await h.fake.redeliver(first);

    const ev = await h.db.query("SELECT * FROM callback_events WHERE kind = 'b2c'");
    assert.equal(ev.rowCount, 1, 'one row for three deliveries');
    assert.equal(ev.rows[0]?.duplicate_count, 2);
    assert.equal((await payoutRow(h, ledgerId)).status, 'PAID');
    await h.close();
  });

  test('the duplicate_callback scenario (KES 104): both copies land, one transition', async () => {
    const h = await createHarness();
    const ledgerId = await seedLedger(h, { payoutMinor: 10_400 });
    await h.call({ method: 'POST', url: '/payouts', payload: { ledgerId } });
    assert.equal(h.fake.peekPending().length, 2);

    await h.fake.deliverPending();

    const ev = await h.db.query("SELECT * FROM callback_events WHERE kind = 'b2c'");
    assert.equal(ev.rowCount, 1);
    assert.equal((await payoutRow(h, ledgerId)).status, 'PAID');
    assert.equal((await ledgerRow(h, ledgerId)).status, 'PAID');
    await h.close();
  });

  test('a result for an OriginatorConversationID we never issued applies nothing', async () => {
    const h = await createHarness();
    const forged: B2CResultBody = {
      Result: {
        ResultType: 0,
        ResultCode: 0,
        ResultDesc: 'ok',
        OriginatorConversationID: randomUUID(),
        ConversationID: 'AG_forged',
        TransactionID: 'FAKE',
      },
    };
    const res = await h.app.inject({ method: 'POST', url: '/callbacks/b2c', payload: forged });
    assert.equal(res.statusCode, 200);

    const ev = await h.db.query("SELECT * FROM callback_events WHERE kind = 'b2c'");
    assert.equal(ev.rows[0]?.matched, false);
    assert.equal(await countRows(h.db, 'payouts'), 0);
    await h.close();
  });

  test('a success result whose amount differs from ours does NOT mark the payout paid', async () => {
    const h = await createHarness();
    const ledgerId = await seedLedger(h);
    await h.call({ method: 'POST', url: '/payouts', payload: { ledgerId } });

    const queued = h.fake.peekPending()[0]!;
    const tampered = structuredClone(queued.body) as B2CResultBody;
    tampered.Result.ResultParameters!.ResultParameter.find((p) => p.Key === 'TransactionAmount')!.Value = 1;

    const res = await h.app.inject({ method: 'POST', url: '/callbacks/b2c', payload: tampered });
    assert.equal(res.statusCode, 200);
    assert.equal((await payoutRow(h, ledgerId)).status, 'PENDING');
    assert.equal((await ledgerRow(h, ledgerId)).status, 'REQUESTED');
    await h.close();
  });

  test('a malformed b2c body is a 400 and writes nothing', async () => {
    const h = await createHarness();
    for (const payload of [{}, { Result: {} }, { Result: { OriginatorConversationID: 'x' } }]) {
      const res = await h.app.inject({ method: 'POST', url: '/callbacks/b2c', payload });
      assert.equal(res.statusCode, 400);
    }
    assert.equal(await countRows(h.db, 'callback_events'), 0);
    await h.close();
  });
});

describe('validation and auth', () => {
  test('an unknown ledgerId is a 404, not a payout', async () => {
    const h = await createHarness();
    const res = await h.call({ method: 'POST', url: '/payouts', payload: { ledgerId: randomUUID() } });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'ledger_not_found');
    assert.equal(await countRows(h.db, 'payouts'), 0);
    await h.close();
  });

  test('a zero payout is refused — there is nothing to send', async () => {
    const h = await createHarness();
    const ledgerId = await seedLedger(h, { payoutMinor: 0 });
    const res = await h.call({ method: 'POST', url: '/payouts', payload: { ledgerId } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'nothing_to_pay');
    await h.close();
  });

  test('a missing or malformed ledgerId is a 400', async () => {
    const h = await createHarness();
    for (const [payload, code] of [
      [{}, 'missing_ledger_id'],
      [{ ledgerId: 'not-a-uuid' }, 'invalid_ledger_id'],
    ] as const) {
      const res = await h.call({ method: 'POST', url: '/payouts', payload });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, code);
    }
    await h.close();
  });

  test('POST /payouts requires the service token', async () => {
    const h = await createHarness();
    const ledgerId = await seedLedger(h);
    const res = await h.app.inject({ method: 'POST', url: '/payouts', payload: { ledgerId } });
    assert.equal(res.statusCode, 401);
    assert.equal(await countRows(h.db, 'payouts'), 0);
    await h.close();
  });

  test('read-back by id and by ledger; unknown -> 404', async () => {
    const h = await createHarness();
    const ledgerId = await seedLedger(h);
    const created = await h.call({ method: 'POST', url: '/payouts', payload: { ledgerId } });
    const id = created.json().payoutId;

    assert.equal((await h.call({ method: 'GET', url: `/payouts/${id}` })).json().ledgerId, ledgerId);
    assert.equal((await h.call({ method: 'GET', url: `/payouts/by-ledger/${ledgerId}` })).json().payoutId, id);
    assert.equal((await h.call({ method: 'GET', url: `/payouts/${randomUUID()}` })).statusCode, 404);
    await h.close();
  });
});
