/**
 * The FakeAdapter is the foundation every Payments invariant test stands on,
 * so it gets its own proof: every row of the ADR 0005 scenario table, the
 * delivery controls the replay/reorder drills rely on, and determinism.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toMinorUnits } from '@tillflow/shared/money';
import {
  FakeAdapter,
  MpesaTimeoutError,
  STK_RESULT,
  B2C_RESULT,
  scenarioFor,
  metadataItem,
  resultParameter,
  type PendingCallback,
  type StkCallbackBody,
  type B2CResultBody,
  type StkPushRequest,
  type B2CRequest,
} from '../src/index.js';

function stkReq(amountMinor: number, extra: Partial<StkPushRequest> = {}): StkPushRequest {
  return {
    amountMinor: toMinorUnits(amountMinor),
    phoneNumber: '254708374149',
    shortCode: '174379',
    accountReference: 'TILL-TEST',
    transactionDesc: 'test',
    callbackUrl: 'http://payments.test/callbacks/stk',
    ...extra,
  };
}

function b2cReq(amountMinor: number, extra: Partial<B2CRequest> = {}): B2CRequest {
  return {
    amountMinor: toMinorUnits(amountMinor),
    phoneNumber: '254708374149',
    originatorConversationId: 'ledger-0001',
    remarks: 'daily commission',
    resultUrl: 'http://payments.test/callbacks/b2c',
    timeoutUrl: 'http://payments.test/callbacks/b2c-timeout',
    ...extra,
  };
}

/** A controllable clock + a deliver() that records what it was handed. */
function harness(startMs = 1_700_000_000_000) {
  let now = startMs;
  const received: PendingCallback[] = [];
  const fake = new FakeAdapter({
    clock: () => now,
    seed: 1,
    deliver: async (cb) => {
      received.push(cb);
    },
  });
  return { fake, received, advance: (ms: number) => { now += ms; } };
}

describe('scenario selection', () => {
  test('is keyed on the last two digits of the SHILLING amount (KES 101 = cancelled)', () => {
    assert.equal(scenarioFor(10_000), 'success'); // KES 100
    assert.equal(scenarioFor(10_100), 'cancelled'); // KES 101
    assert.equal(scenarioFor(10_200), 'insufficient_funds'); // KES 102
    assert.equal(scenarioFor(10_300), 'timeout'); // KES 103
    assert.equal(scenarioFor(10_400), 'duplicate_callback'); // KES 104
    assert.equal(scenarioFor(10_500), 'delayed_callback'); // KES 105
  });

  test('other suffixes are ordinary money, not undefined behaviour', () => {
    assert.equal(scenarioFor(15_000), 'success'); // KES 150
    assert.equal(scenarioFor(19_900), 'success'); // KES 199
    assert.equal(scenarioFor(100_300), 'timeout'); // KES 1003 — only the last two digits count
  });

  test('cents never select a scenario (Daraja cannot carry them anyway)', () => {
    // KES 100.03 would be refused by the adapters; the selector alone just ignores the cents.
    assert.equal(scenarioFor(10_003), 'success');
  });

  test('an explicit hint overrides the amount; an unknown hint is loud', () => {
    assert.equal(scenarioFor(10_000, 'timeout'), 'timeout');
    assert.throws(() => scenarioFor(10_000, 'explode'), /unknown fake scenario/);
  });
});

describe('STK push scenarios', () => {
  test('success: ack + one queued callback with ResultCode 0 and metadata', async () => {
    const { fake } = harness();
    const ack = await fake.stkPush(stkReq(25_000));

    assert.equal(ack.responseCode, '0');
    assert.match(ack.checkoutRequestId, /^ws_CO_fake_/);

    const pending = fake.peekPending();
    assert.equal(pending.length, 1);
    const cb = pending[0]!;
    assert.equal(cb.kind, 'stk');
    assert.equal(cb.url, 'http://payments.test/callbacks/stk');
    assert.equal(cb.reference, ack.checkoutRequestId);

    const body = cb.body as StkCallbackBody;
    assert.equal(body.Body.stkCallback.ResultCode, STK_RESULT.SUCCESS);
    assert.equal(body.Body.stkCallback.CheckoutRequestID, ack.checkoutRequestId);
    // Daraja reports KES, not cents.
    assert.equal(metadataItem(body, 'Amount'), 250);
    assert.match(String(metadataItem(body, 'MpesaReceiptNumber')), /^FAKE\d{6}$/);
  });

  test('cancelled: ResultCode 1032, no metadata', async () => {
    const { fake } = harness();
    await fake.stkPush(stkReq(10_100));
    const body = fake.peekPending()[0]!.body as StkCallbackBody;
    assert.equal(body.Body.stkCallback.ResultCode, STK_RESULT.CANCELLED_BY_USER);
    assert.equal(body.Body.stkCallback.CallbackMetadata, undefined);
  });

  test('insufficient funds: ResultCode 1', async () => {
    const { fake } = harness();
    await fake.stkPush(stkReq(10_200));
    const body = fake.peekPending()[0]!.body as StkCallbackBody;
    assert.equal(body.Body.stkCallback.ResultCode, STK_RESULT.INSUFFICIENT_FUNDS);
  });

  test('timeout: throws MpesaTimeoutError, queues nothing, but the attempt is recorded', async () => {
    const { fake } = harness();
    await assert.rejects(fake.stkPush(stkReq(10_300)), MpesaTimeoutError);
    assert.equal(fake.peekPending().length, 0, 'no callback: the caller heard nothing');
    assert.equal(fake.unresolvedTimeouts().length, 1, 'but Daraja "received" it');
  });

  test('timeout then resolveTimeout: query flips from pending to complete and the late callback is queued', async () => {
    const { fake } = harness();
    await assert.rejects(fake.stkPush(stkReq(10_300)), MpesaTimeoutError);
    const [id] = fake.unresolvedTimeouts();
    assert.ok(id);

    assert.deepEqual(await fake.stkQuery(id), { status: 'pending' });

    fake.resolveTimeout(id, 'success');
    const q = await fake.stkQuery(id);
    assert.equal(q.status, 'complete');
    if (q.status === 'complete') assert.equal(q.resultCode, STK_RESULT.SUCCESS);
    assert.equal(fake.peekPending().length, 1, 'the late callback is now queued');
    assert.equal(fake.unresolvedTimeouts().length, 0);
  });

  test('duplicate_callback: the same successful callback is queued twice', async () => {
    const { fake } = harness();
    const ack = await fake.stkPush(stkReq(10_400));
    const pending = fake.peekPending();
    assert.equal(pending.length, 2);
    assert.deepEqual(pending[0]!.body, pending[1]!.body, 'byte-identical');
    assert.equal(pending[0]!.reference, ack.checkoutRequestId);
  });

  test('delayed_callback: not due until the clock passes the delay; query stays pending meanwhile', async () => {
    const { fake, received, advance } = harness();
    const ack = await fake.stkPush(stkReq(10_500));

    assert.equal(await fake.deliverPending(), 0, 'nothing due yet');
    assert.equal(received.length, 0);
    assert.deepEqual(await fake.stkQuery(ack.checkoutRequestId), { status: 'pending' });

    advance(61_000);
    assert.equal(await fake.deliverPending(), 1);
    assert.equal(received.length, 1);
    const q = await fake.stkQuery(ack.checkoutRequestId);
    assert.equal(q.status, 'complete');
  });

  test('scenarioHint on the request forces a scenario regardless of amount', async () => {
    const { fake } = harness();
    await assert.rejects(fake.stkPush(stkReq(25_000, { scenarioHint: 'timeout' })), MpesaTimeoutError);
  });

  test('a fractional-shilling amount is refused by the fake exactly as the real adapter refuses it', async () => {
    const { fake } = harness();
    await assert.rejects(fake.stkPush(stkReq(250)), /whole shillings/);
    await assert.rejects(fake.b2cPayment(b2cReq(150_050)), /whole shillings/);
    assert.equal(fake.peekPending().length, 0);
  });

  test('stkQuery for an unknown id is pending, not an exception', async () => {
    const { fake } = harness();
    assert.deepEqual(await fake.stkQuery('ws_CO_never_issued'), { status: 'pending' });
  });
});

describe('delivery controls (what the replay/reorder drills use)', () => {
  test('deliverPending in FIFO order by default, reverse on request', async () => {
    const { fake, received } = harness();
    const a = await fake.stkPush(stkReq(10_000));
    const b = await fake.stkPush(stkReq(20_000));

    await fake.deliverPending({ order: 'reverse' });
    assert.deepEqual(
      received.map((r) => r.reference),
      [b.checkoutRequestId, a.checkoutRequestId],
    );
  });

  test('redeliver sends an already-delivered callback again, byte-identical', async () => {
    const { fake, received } = harness();
    await fake.stkPush(stkReq(10_000));
    await fake.deliverPending();
    const first = fake.deliveredCallbacks()[0]!;

    await fake.redeliver(first);
    assert.equal(received.length, 2);
    assert.deepEqual(received[0]!.body, received[1]!.body);
  });

  test('deliverPending without a deliver function is a loud error, not a silent no-op', async () => {
    const fake = new FakeAdapter();
    await fake.stkPush(stkReq(10_000));
    await assert.rejects(fake.deliverPending(), /no `deliver` function/);
  });
});

describe('B2C scenarios', () => {
  test('success: ack echoes our originator id; result carries TransactionID and amount in KES', async () => {
    const { fake } = harness();
    const ack = await fake.b2cPayment(b2cReq(150_000));
    assert.equal(ack.originatorConversationId, 'ledger-0001');
    assert.match(ack.conversationId, /^AG_fake_/);

    const body = fake.peekPending()[0]!.body as B2CResultBody;
    assert.equal(body.Result.ResultCode, B2C_RESULT.SUCCESS);
    assert.equal(body.Result.OriginatorConversationID, 'ledger-0001');
    assert.equal(body.Result.ConversationID, ack.conversationId);
    assert.match(body.Result.TransactionID, /^FAKEB2C/);
    assert.equal(resultParameter(body, 'TransactionAmount'), 1500);
  });

  test('insufficient balance: ResultCode 1, empty TransactionID', async () => {
    const { fake } = harness();
    await fake.b2cPayment(b2cReq(150_200));
    const body = fake.peekPending()[0]!.body as B2CResultBody;
    assert.equal(body.Result.ResultCode, B2C_RESULT.INSUFFICIENT_BALANCE);
    assert.equal(body.Result.TransactionID, '');
  });

  test('timeout: throws, queues nothing', async () => {
    const { fake } = harness();
    await assert.rejects(fake.b2cPayment(b2cReq(150_300)), MpesaTimeoutError);
    assert.equal(fake.peekPending().length, 0);
  });

  test('duplicate_callback: two identical results queued', async () => {
    const { fake } = harness();
    await fake.b2cPayment(b2cReq(150_400));
    const pending = fake.peekPending();
    assert.equal(pending.length, 2);
    assert.deepEqual(pending[0]!.body, pending[1]!.body);
  });
});

describe('determinism', () => {
  test('same seed + same inputs = byte-identical ids and callbacks', async () => {
    const run = async () => {
      const { fake } = harness();
      const ack = await fake.stkPush(stkReq(25_000));
      return { ack, cb: fake.peekPending()[0]!.body };
    };
    const [a, b] = await Promise.all([run(), run()]);
    assert.deepEqual(a.ack, b.ack);
    assert.deepEqual(a.cb, b.cb);
  });

  test('ids never collide within one adapter across STK and B2C', async () => {
    const { fake } = harness();
    const s1 = await fake.stkPush(stkReq(10_000));
    const p1 = await fake.b2cPayment(b2cReq(10_000));
    const s2 = await fake.stkPush(stkReq(10_000));
    const ids = new Set([s1.checkoutRequestId, p1.conversationId, s2.checkoutRequestId]);
    assert.equal(ids.size, 3);
  });
});
