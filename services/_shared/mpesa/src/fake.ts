/**
 * FakeAdapter — deterministic, in-process, persists nothing (ADR 0005).
 *
 * What it models, and how a test drives it:
 *
 *   - Outcome comes from the scenario table (scenario.ts): the amount's last
 *     two digits, or an explicit hint. No randomness, no wall clock unless
 *     you inject one.
 *   - Callbacks are NOT delivered on their own. Each push/payout queues the
 *     callback(s) its scenario calls for; the test decides when they land,
 *     in what order, and how many times, via `deliverPending()`. That is the
 *     whole point: replay and reorder drills need the test to own delivery.
 *   - `deliver` is injected. A unit test hands in `app.inject(...)`; the k6
 *     stub-server hands in `fetch`. Either way the Payments service runs its
 *     real callback route — dedupe, guarded transition, outbox, trace.
 *   - A `timeout` scenario throws MpesaTimeoutError from the push AND still
 *     records the attempt internally, because that is the dangerous real-world
 *     case: the request reached Daraja, only the response was lost. The test
 *     can then `resolveTimeout()` to decide what "really" happened and queue
 *     the late callback, which is what the uncertain-payment drill needs.
 *   - `stkQuery` answers `pending` until the customer has "acted" — i.e. until
 *     the scenario's callback is due — mirroring Daraja's "transaction is
 *     being processed" (500.001.1001).
 *
 * Ids are sequential from a seed so two runs with the same inputs produce
 * byte-identical callbacks; a test can assert on them directly.
 */
import type { MpesaAdapter } from './adapter.js';
import { MpesaTimeoutError } from './adapter.js';
import { scenarioFor, type FakeScenario } from './scenario.js';
import { minorToKes } from './wire.js';
import {
  STK_RESULT,
  B2C_RESULT,
  type StkPushRequest,
  type StkPushAck,
  type StkQueryResult,
  type StkCallbackBody,
  type B2CRequest,
  type B2CAck,
  type B2CResultBody,
} from './types.js';

export interface PendingCallback {
  kind: 'stk' | 'b2c';
  url: string;
  body: StkCallbackBody | B2CResultBody;
  /** The CheckoutRequestID or ConversationID this callback belongs to. */
  reference: string;
  /** Wall-clock ms (per the injected clock) before which this must not be delivered. */
  notBeforeMs: number;
}

export interface FakeAdapterOptions {
  /** Injected clock in ms. Defaults to Date.now. Tests pass a controllable one. */
  clock?: () => number;
  /** Starting sequence number for generated ids. Same seed + same inputs = same ids. */
  seed?: number;
  /** How late a `delayed_callback` lands. Defaults to 61s — just past the Payments SLO's 60s. */
  delayedCallbackMs?: number;
  /**
   * How a queued callback reaches the Payments service. Required before
   * `deliverPending()` is called; injected rather than defaulted so a unit
   * test can route through Fastify's `inject` with no socket at all.
   */
  deliver?: (cb: PendingCallback) => Promise<void>;
}

interface StkRecord {
  scenario: FakeScenario;
  request: StkPushRequest;
  merchantRequestId: string;
  /** The result stkQuery will report once the customer has "acted"; undefined = still pending. */
  result?: { resultCode: number; resultDesc: string };
  /** When the customer "acts" (the scenario's callback due time). */
  actsAtMs?: number;
}

interface B2CRecord {
  scenario: FakeScenario;
  request: B2CRequest;
  result?: { resultCode: number; resultDesc: string };
}

export class FakeAdapter implements MpesaAdapter {
  private readonly clock: () => number;
  private readonly delayedCallbackMs: number;
  private readonly deliverFn: ((cb: PendingCallback) => Promise<void>) | undefined;
  private seq: number;

  private readonly stk = new Map<string, StkRecord>();
  private readonly b2c = new Map<string, B2CRecord>();
  private pending: PendingCallback[] = [];
  private readonly delivered: PendingCallback[] = [];

  constructor(opts: FakeAdapterOptions = {}) {
    this.clock = opts.clock ?? (() => Date.now());
    this.seq = opts.seed ?? 1;
    this.delayedCallbackMs = opts.delayedCallbackMs ?? 61_000;
    this.deliverFn = opts.deliver;
  }

  // -------------------------------------------------------------------------
  // MpesaAdapter
  // -------------------------------------------------------------------------

  async stkPush(req: StkPushRequest): Promise<StkPushAck> {
    // Same validation the real adapter applies, so a test cannot pass with an
    // amount prod would refuse.
    minorToKes(req.amountMinor);
    const scenario = scenarioFor(req.amountMinor, req.scenarioHint);
    const n = this.next();
    const merchantRequestId = `fake-mr-${n}`;
    const checkoutRequestId = `ws_CO_fake_${String(n).padStart(6, '0')}`;
    const now = this.clock();

    const record: StkRecord = { scenario, request: req, merchantRequestId };
    this.stk.set(checkoutRequestId, record);

    if (scenario === 'timeout') {
      // The request "reached Daraja" — the record exists and a late callback
      // can still be produced via resolveTimeout() — but the caller never
      // hears back. Provider state is unknown; the charge must stay PENDING.
      throw new MpesaTimeoutError();
    }

    const dueAt = scenario === 'delayed_callback' ? now + this.delayedCallbackMs : now;
    record.actsAtMs = dueAt;

    switch (scenario) {
      case 'success':
      case 'delayed_callback':
        record.result = { resultCode: STK_RESULT.SUCCESS, resultDesc: 'The service request is processed successfully.' };
        this.queueStk(checkoutRequestId, record, dueAt, n);
        break;
      case 'duplicate_callback':
        // Same successful callback, twice. Order and spacing are the test's
        // call — that is what deliverPending({ order }) is for.
        record.result = { resultCode: STK_RESULT.SUCCESS, resultDesc: 'The service request is processed successfully.' };
        this.queueStk(checkoutRequestId, record, dueAt, n);
        this.queueStk(checkoutRequestId, record, dueAt, n);
        break;
      case 'cancelled':
        record.result = { resultCode: STK_RESULT.CANCELLED_BY_USER, resultDesc: 'Request cancelled by user' };
        this.queueStk(checkoutRequestId, record, dueAt, n);
        break;
      case 'insufficient_funds':
        record.result = { resultCode: STK_RESULT.INSUFFICIENT_FUNDS, resultDesc: 'The balance is insufficient for the transaction' };
        this.queueStk(checkoutRequestId, record, dueAt, n);
        break;
    }

    return {
      merchantRequestId,
      checkoutRequestId,
      responseCode: '0',
      responseDescription: 'Success. Request accepted for processing',
      customerMessage: 'Success. Request accepted for processing',
    };
  }

  async stkQuery(checkoutRequestId: string): Promise<StkQueryResult> {
    const record = this.stk.get(checkoutRequestId);
    // An id we never issued: Daraja would 404-ish. Reported as pending rather
    // than throwing so the reconciler's "ask again later" path is exercised
    // the same way; the Payments service guards unknown ids before this.
    if (!record?.result || record.actsAtMs === undefined || this.clock() < record.actsAtMs) {
      return { status: 'pending' };
    }
    return { status: 'complete', ...record.result };
  }

  async b2cPayment(req: B2CRequest): Promise<B2CAck> {
    minorToKes(req.amountMinor);
    const scenario = scenarioFor(req.amountMinor, req.scenarioHint);
    const n = this.next();
    const conversationId = `AG_fake_${String(n).padStart(6, '0')}`;
    const now = this.clock();

    const record: B2CRecord = { scenario, request: req };
    this.b2c.set(conversationId, record);

    if (scenario === 'timeout') {
      throw new MpesaTimeoutError();
    }

    const dueAt = scenario === 'delayed_callback' ? now + this.delayedCallbackMs : now;

    switch (scenario) {
      case 'success':
      case 'delayed_callback':
        record.result = { resultCode: B2C_RESULT.SUCCESS, resultDesc: 'The service request is processed successfully.' };
        this.queueB2C(conversationId, record, dueAt, n);
        break;
      case 'duplicate_callback':
        record.result = { resultCode: B2C_RESULT.SUCCESS, resultDesc: 'The service request is processed successfully.' };
        this.queueB2C(conversationId, record, dueAt, n);
        this.queueB2C(conversationId, record, dueAt, n);
        break;
      case 'cancelled':
      case 'insufficient_funds':
        // B2C has no "customer cancelled"; both map to the business's own
        // balance being short — the realistic payout failure.
        record.result = { resultCode: B2C_RESULT.INSUFFICIENT_BALANCE, resultDesc: 'The initiator information is invalid.' };
        this.queueB2C(conversationId, record, dueAt, n);
        break;
    }

    return {
      conversationId,
      originatorConversationId: req.originatorConversationId,
      responseCode: '0',
      responseDescription: 'Accept the service request successfully.',
    };
  }

  // -------------------------------------------------------------------------
  // Test controls
  // -------------------------------------------------------------------------

  /** Callbacks queued and not yet delivered, in FIFO order. */
  peekPending(): readonly PendingCallback[] {
    return [...this.pending];
  }

  /** Every callback that has been delivered, in delivery order. */
  deliveredCallbacks(): readonly PendingCallback[] {
    return [...this.delivered];
  }

  /**
   * Delivers every due callback through the injected `deliver`, and returns
   * how many went. `order: 'reverse'` delivers the due set last-first — the
   * reorder drill. A callback whose `notBeforeMs` is in the future (per the
   * injected clock) stays queued until the clock catches up.
   */
  async deliverPending(opts: { order?: 'fifo' | 'reverse' } = {}): Promise<number> {
    if (!this.deliverFn) {
      throw new Error('FakeAdapter: no `deliver` function configured; pass one in the constructor');
    }
    const now = this.clock();
    const due = this.pending.filter((cb) => cb.notBeforeMs <= now);
    this.pending = this.pending.filter((cb) => cb.notBeforeMs > now);

    const ordered = opts.order === 'reverse' ? [...due].reverse() : due;
    for (const cb of ordered) {
      await this.deliverFn(cb);
      this.delivered.push(cb);
    }
    return ordered.length;
  }

  /**
   * Re-deliver an already-delivered callback verbatim — the replay drill
   * (SQS-style at-least-once, or Daraja retrying a callback it thinks we
   * missed). Same bytes, second time.
   */
  async redeliver(cb: PendingCallback): Promise<void> {
    if (!this.deliverFn) {
      throw new Error('FakeAdapter: no `deliver` function configured');
    }
    await this.deliverFn(cb);
    this.delivered.push(cb);
  }

  /**
   * For a `timeout` scenario: decide what actually happened on Daraja's side.
   * Sets the stkQuery answer and (optionally) queues the late callback, so
   * the uncertain-payment drill can prove the reconciler resolves it via
   * query, and that a late callback after query-resolution is a no-op.
   */
  resolveTimeout(
    checkoutRequestId: string,
    outcome: 'success' | 'cancelled' | 'insufficient_funds',
    opts: { queueCallback?: boolean } = {},
  ): void {
    const record = this.stk.get(checkoutRequestId);
    if (!record) {
      throw new Error(`FakeAdapter: unknown CheckoutRequestID ${checkoutRequestId}`);
    }
    if (record.scenario !== 'timeout') {
      throw new Error(`FakeAdapter: ${checkoutRequestId} is scenario "${record.scenario}", not timeout`);
    }
    const now = this.clock();
    record.actsAtMs = now;
    switch (outcome) {
      case 'success':
        record.result = { resultCode: STK_RESULT.SUCCESS, resultDesc: 'The service request is processed successfully.' };
        break;
      case 'cancelled':
        record.result = { resultCode: STK_RESULT.CANCELLED_BY_USER, resultDesc: 'Request cancelled by user' };
        break;
      case 'insufficient_funds':
        record.result = { resultCode: STK_RESULT.INSUFFICIENT_FUNDS, resultDesc: 'The balance is insufficient for the transaction' };
        break;
    }
    if (opts.queueCallback ?? true) {
      const n = Number(checkoutRequestId.replace(/^\D+/, ''));
      this.queueStk(checkoutRequestId, record, now, n);
    }
  }

  /** CheckoutRequestIDs of pushes that timed out and have not been resolved. */
  unresolvedTimeouts(): string[] {
    return [...this.stk.entries()]
      .filter(([, r]) => r.scenario === 'timeout' && !r.result)
      .map(([id]) => id);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private next(): number {
    return this.seq++;
  }

  private queueStk(checkoutRequestId: string, record: StkRecord, notBeforeMs: number, n: number): void {
    if (!record.result) return;
    const { resultCode, resultDesc } = record.result;
    const stkCallback: StkCallbackBody['Body']['stkCallback'] = {
      MerchantRequestID: record.merchantRequestId,
      CheckoutRequestID: checkoutRequestId,
      ResultCode: resultCode,
      ResultDesc: resultDesc,
    };
    if (resultCode === STK_RESULT.SUCCESS) {
      stkCallback.CallbackMetadata = {
        Item: [
          // Daraja reports Amount in KES as a JSON number.
          { Name: 'Amount', Value: minorToKes(record.request.amountMinor) },
          { Name: 'MpesaReceiptNumber', Value: `FAKE${String(n).padStart(6, '0')}` },
          { Name: 'TransactionDate', Value: formatDarajaDate(notBeforeMs) },
          { Name: 'PhoneNumber', Value: Number(record.request.phoneNumber) },
        ],
      };
    }
    this.pending.push({
      kind: 'stk',
      url: record.request.callbackUrl,
      body: { Body: { stkCallback } },
      reference: checkoutRequestId,
      notBeforeMs,
    });
  }

  private queueB2C(conversationId: string, record: B2CRecord, notBeforeMs: number, n: number): void {
    if (!record.result) return;
    const { resultCode, resultDesc } = record.result;
    const transactionId = resultCode === B2C_RESULT.SUCCESS ? `FAKEB2C${String(n).padStart(5, '0')}` : '';
    const body: B2CResultBody = {
      Result: {
        ResultType: 0,
        ResultCode: resultCode,
        ResultDesc: resultDesc,
        OriginatorConversationID: record.request.originatorConversationId,
        ConversationID: conversationId,
        TransactionID: transactionId,
      },
    };
    if (resultCode === B2C_RESULT.SUCCESS) {
      body.Result.ResultParameters = {
        ResultParameter: [
          { Key: 'TransactionAmount', Value: minorToKes(record.request.amountMinor) },
          { Key: 'TransactionReceipt', Value: transactionId },
          { Key: 'ReceiverPartyPublicName', Value: `${record.request.phoneNumber} - Attendant` },
          { Key: 'TransactionCompletedDateTime', Value: formatDarajaDate(notBeforeMs) },
        ],
      };
    }
    this.pending.push({
      kind: 'b2c',
      url: record.request.resultUrl,
      body,
      reference: conversationId,
      notBeforeMs,
    });
  }
}

/** yyyyMMddHHmmss, as Daraja formats TransactionDate. UTC — deterministic under an injected clock. */
function formatDarajaDate(ms: number): number {
  const d = new Date(ms);
  const p = (v: number, w = 2): string => String(v).padStart(w, '0');
  return Number(
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`,
  );
}
