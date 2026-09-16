/**
 * The outbox relay. At-least-once on purpose: a crash between the send and
 * the mark redelivers, and POS's consumer is idempotent on saleId. The
 * alternative — marking before sending — can lose a sale.paid, which would
 * leave a paid sale showing UNPAID forever.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { SalePaidEvent } from '@tillflow/shared/events';
import { isSalePaidEvent } from '@tillflow/shared/events';
import { relayOnce, type EventPublisher } from '../src/services/outbox.js';
import { createHarness, chargeBody, type Harness } from './harness.js';

class RecordingPublisher implements EventPublisher {
  readonly sent: SalePaidEvent[] = [];
  failNext = 0;
  async publish(event: SalePaidEvent): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('SQS unavailable');
    }
    this.sent.push(event);
  }
}

/** Drive a sale all the way to PAID so an outbox row exists. */
async function paidCharge(h: Harness): Promise<string> {
  const body = chargeBody();
  const res = await h.call({ method: 'POST', url: '/charges', payload: body });
  await h.fake.deliverPending();
  return res.json().chargeId as string;
}

describe('relay', () => {
  test('publishes unpublished events and marks them, exactly once each', async () => {
    const h = await createHarness();
    await paidCharge(h);
    await paidCharge(h);
    const publisher = new RecordingPublisher();

    const first = await relayOnce({ db: h.db, publisher, now: h.nowDate });
    assert.deepEqual(first, { published: 2, failed: 0 });
    assert.ok(publisher.sent.every(isSalePaidEvent), 'every message is a valid SalePaidEvent');

    // A second pass has nothing to do — published rows are not re-sent.
    const second = await relayOnce({ db: h.db, publisher, now: h.nowDate });
    assert.deepEqual(second, { published: 0, failed: 0 });
    assert.equal(publisher.sent.length, 2);
    await h.close();
  });

  test('a send failure leaves the row unpublished, records the error, and retries next pass', async () => {
    const h = await createHarness();
    await paidCharge(h);
    const publisher = new RecordingPublisher();
    publisher.failNext = 1;

    const failed = await relayOnce({ db: h.db, publisher, now: h.nowDate });
    assert.deepEqual(failed, { published: 0, failed: 1 });

    const row = await h.db.query('SELECT published_at, publish_attempts, last_error FROM outbox_events');
    assert.equal(row.rows[0]?.published_at, null, 'not marked published');
    assert.equal(row.rows[0]?.publish_attempts, 1);
    assert.match(row.rows[0]?.last_error, /SQS unavailable/);

    const retry = await relayOnce({ db: h.db, publisher, now: h.nowDate });
    assert.deepEqual(retry, { published: 1, failed: 0 });
    await h.close();
  });

  test('a crash between send and mark redelivers rather than losing the event', async () => {
    const h = await createHarness();
    await paidCharge(h);

    // Publisher succeeds, but the process dies before published_at is set.
    const publisher = new RecordingPublisher();
    const crashing: EventPublisher = {
      publish: async (e) => {
        await publisher.publish(e);
        throw new Error('crashed after send, before mark');
      },
    };
    await relayOnce({ db: h.db, publisher: crashing, now: h.nowDate });
    assert.equal(publisher.sent.length, 1, 'the event DID reach the queue');

    // Next pass sends it again — at-least-once. POS dedupes on saleId.
    const after = await relayOnce({ db: h.db, publisher, now: h.nowDate });
    assert.equal(after.published, 1);
    assert.equal(publisher.sent.length, 2, 'duplicate delivery, not a lost event');
    assert.equal(publisher.sent[0]?.data.saleId, publisher.sent[1]?.data.saleId);
    await h.close();
  });

  test('a declined charge produces nothing to relay', async () => {
    const h = await createHarness();
    await h.call({ method: 'POST', url: '/charges', payload: chargeBody({ amountMinor: 10_100 }) }); // cancelled
    await h.fake.deliverPending();

    const publisher = new RecordingPublisher();
    assert.deepEqual(await relayOnce({ db: h.db, publisher, now: h.nowDate }), { published: 0, failed: 0 });
    await h.close();
  });
});
