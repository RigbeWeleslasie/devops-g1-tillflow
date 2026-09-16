/**
 * The ONE test that talks to the real Daraja 3.0 sandbox (ADR 0005).
 *
 * Everything else in this repo runs against the FakeAdapter or the
 * stub-server. This exists to answer a single question the stub cannot:
 * does Safaricom still agree with the wire format we send?
 *
 * It is SKIPPED unless real sandbox credentials are present, so `npm test`
 * stays hermetic and CI never depends on a third party being up. Run it
 * deliberately:
 *
 *   DARAJA_CONSUMER_KEY=... DARAJA_CONSUMER_SECRET=... \
 *   DARAJA_PASSKEY=... DARAJA_SHORTCODE=174379 \
 *   node --import tsx --test services/_shared/mpesa/test/contract.test.ts
 *
 * In the sandbox, 174379 is Safaricom's shared test shortcode and
 * 254708374149 their test MSISDN; no real money moves. The amount is KES 1.
 * It never runs under k6 (the brief: "use the Daraja sandbox only for a
 * small contract test") and never in the PR lane.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toMinorUnits } from '@tillflow/shared/money';
import { DarajaAdapter, MpesaError, type DarajaCredentials } from '../src/index.js';

const key = process.env['DARAJA_CONSUMER_KEY'];
const secret = process.env['DARAJA_CONSUMER_SECRET'];
const passkey = process.env['DARAJA_PASSKEY'];
const shortCode = process.env['DARAJA_SHORTCODE'] ?? '174379';

const configured = Boolean(key && secret && passkey);

const credentials: DarajaCredentials = {
  consumerKey: key ?? '',
  consumerSecret: secret ?? '',
  passkey: passkey ?? '',
  stkShortCode: shortCode,
  b2c: {
    shortCode: process.env['DARAJA_B2C_SHORTCODE'] ?? '600000',
    initiatorName: process.env['DARAJA_B2C_INITIATOR'] ?? 'testapi',
    securityCredential: process.env['DARAJA_B2C_SECURITY_CREDENTIAL'] ?? '',
  },
};

function adapter(): DarajaAdapter {
  return new DarajaAdapter({
    baseUrl: process.env['DARAJA_BASE_URL'] ?? 'https://sandbox.safaricom.co.ke',
    credentials,
    timeoutMs: 20_000,
  });
}

describe('@contract — real Daraja sandbox', { skip: configured ? false : 'DARAJA_* not set' }, () => {
  test('OAuth returns a usable token', async () => {
    // Exercised indirectly: any call that succeeds proves the token worked,
    // since every request goes through accessToken() first.
    const q = await adapter().stkQuery('ws_CO_definitely_not_a_real_id');
    // Either answer is fine — what matters is that we authenticated and got
    // a structured response rather than a transport or auth error.
    assert.ok(q.status === 'pending' || q.status === 'complete');
  });

  test('STK Push: the sandbox accepts our request envelope and returns the ack shape we expect', async () => {
    const ack = await adapter().stkPush({
      amountMinor: toMinorUnits(100), // KES 1 — the sandbox minimum
      phoneNumber: process.env['DARAJA_TEST_MSISDN'] ?? '254708374149',
      shortCode,
      accountReference: 'TFCONTRACT',
      transactionDesc: 'contract test',
      // A URL that will never be called back; we assert on the ack only.
      callbackUrl: process.env['MPESA_CALLBACK_BASE_URL']
        ? `${process.env['MPESA_CALLBACK_BASE_URL']}/callbacks/stk`
        : 'https://example.invalid/callbacks/stk',
    });

    assert.equal(ack.responseCode, '0', ack.responseDescription);
    assert.ok(ack.checkoutRequestId.length > 0, 'CheckoutRequestID is present');
    assert.ok(ack.merchantRequestId.length > 0, 'MerchantRequestID is present');
    assert.equal(typeof ack.customerMessage, 'string');

    // And the id we were just given is queryable — the sandbox reports it as
    // in-flight, which our adapter maps to `pending` rather than an error.
    // This is the behaviour I5 depends on, confirmed against the real API.
    const q = await adapter().stkQuery(ack.checkoutRequestId);
    assert.ok(q.status === 'pending' || q.status === 'complete');
  });

  test('a fractional-shilling amount is refused by us before the sandbox ever sees it', async () => {
    await assert.rejects(
      adapter().stkPush({
        amountMinor: toMinorUnits(150), // KES 1.50
        phoneNumber: '254708374149',
        shortCode,
        accountReference: 'TFCONTRACT',
        transactionDesc: 'contract test',
        callbackUrl: 'https://example.invalid/callbacks/stk',
      }),
      /whole shillings/,
    );
  });

  test('bad credentials surface as MpesaAuthError, not as a payment outcome', async () => {
    const bad = new DarajaAdapter({
      baseUrl: process.env['DARAJA_BASE_URL'] ?? 'https://sandbox.safaricom.co.ke',
      credentials: { ...credentials, consumerKey: 'nope', consumerSecret: 'nope' },
      timeoutMs: 20_000,
    });
    await assert.rejects(bad.stkQuery('ws_CO_x'), (err: unknown) => err instanceof MpesaError);
  });
});
