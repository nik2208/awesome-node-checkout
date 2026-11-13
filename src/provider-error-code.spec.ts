import { describe, it, expect, beforeEach } from 'vitest';
import { CheckoutConfigurator } from './checkout-configurator';
import { BasePaymentProvider } from './abstract/base-payment-provider.abstract';
import { IMandateProvider } from './interfaces/mandate-provider.interface';
import { PaymentRequest } from './models/payment-request.model';
import { PaymentResult } from './models/payment-result.model';
import type { ProviderErrorCode } from './models/payment-result.model';
import { CheckoutEventName, CheckoutEventPayload } from './events/checkout-event-bus';
import {
  ChargeLookupOptions,
  ChargeLookupResult,
  ChargeRequest,
  ChargeResult,
  Mandate,
  MandateCallbackInput,
  MandatePendingState,
  MandateRevokeResult,
  MandateSetupOutcome,
  MandateSetupRequest,
  MandateSetupStart,
  MandateStatusResult,
} from './models/mandate.model';

// ProviderErrorCode (#53) through the configurator, with a scripted provider: which results keep a provider's
// `errorCode` and which drop it. The PayPal results themselves are in providers/paypal/paypal.oauth.spec.ts.

const F: ProviderErrorCode = 'PROVIDER_AUTH_FAILED';
const U: ProviderErrorCode = 'PROVIDER_AUTH_UNAVAILABLE';

const CHARGE_REF = 'SUB-0001-2026-12';

const mandate: Mandate = {
  provider: 'scripted',
  mandateRef: 'MNDT0000000001',
  providerMandateId: 'vault-tok-0001',
  status: 'active',
  createdAt: '2026-12-01T10:15:00.000Z',
};

const pending: MandatePendingState = {
  provider: 'scripted',
  mandateRef: 'MNDT0000000001',
  orderId: 'SUB-0001-INIT',
  amount: 19.9,
  currency: 'EUR',
  providerRef: 'SCRIPTED-ORDER-1',
  createdAt: '2026-12-01T10:00:00.000Z',
};

const setupRequest: MandateSetupRequest = {
  mandateRef: 'MNDT0000000001',
  orderId: 'SUB-0001-INIT',
  amount: 19.9,
  currency: 'EUR',
  description: 'Monthly plan',
  returnUrl: 'https://shop.test/checkout/scripted/mandate/callback',
  cancelUrl: 'https://shop.test/checkout/scripted/mandate/callback?cancel=1',
};

const charge: ChargeRequest = { chargeRef: CHARGE_REF, amount: 19.9, currency: 'EUR' };

/** Every method returns what its script says: plain objects, built fresh on every call. */
class ScriptedProvider extends BasePaymentProvider implements IMandateProvider {
  readonly name = 'scripted';
  readonly flow = 'redirect' as const;
  payment: () => PaymentResult = () => ({ success: true, paymentId: 'PAY-1', status: 'COMPLETED' });
  start: () => MandateSetupStart = () => ({ success: false, error: 'not scripted' });
  outcome: () => MandateSetupOutcome = () => {
    throw new Error('not scripted');
  };
  chargeResult: () => ChargeResult = () => {
    throw new Error('not scripted');
  };
  status: () => MandateStatusResult = () => ({ status: 'active', verified: true });
  revoke: () => MandateRevokeResult = () => ({ revokedAtProvider: true });
  lookup: () => ChargeLookupResult = () => ({ status: 'absent', verified: true, chargeRef: CHARGE_REF });

  async createPayment(_request: PaymentRequest): Promise<PaymentResult> {
    return this.payment();
  }
  async executePayment(_paymentId: string): Promise<PaymentResult> {
    return this.payment();
  }
  async getPaymentDetails(_paymentId: string): Promise<PaymentResult> {
    return this.payment();
  }
  async refundPayment(_paymentId: string, _amount?: number): Promise<PaymentResult> {
    return this.payment();
  }
  async handleRedirect(_query: Record<string, string>): Promise<PaymentResult> {
    return this.payment();
  }
  async createMandate(_request: MandateSetupRequest): Promise<MandateSetupStart> {
    return this.start();
  }
  async confirmMandate(_pending: MandatePendingState, _input: MandateCallbackInput): Promise<MandateSetupOutcome> {
    return this.outcome();
  }
  async chargeMandate(_mandate: Mandate, _charge: ChargeRequest): Promise<ChargeResult> {
    return this.chargeResult();
  }
  async getMandate(_mandate: Mandate): Promise<MandateStatusResult> {
    return this.status();
  }
  async revokeMandate(_mandate: Mandate): Promise<MandateRevokeResult> {
    return this.revoke();
  }
  async getCharge(_chargeRef: string, _options?: ChargeLookupOptions): Promise<ChargeLookupResult> {
    return this.lookup();
  }
}

/** Every CheckoutEventName (the type has no runtime list). */
const ALL_EVENTS: CheckoutEventName[] = [
  'payment.created',
  'payment.completed',
  'payment.failed',
  'payment.refunded',
  'webhook.received',
  'mandate.setup_started',
  'mandate.created',
  'mandate.setup_failed',
  'mandate.revoked',
  'charge.succeeded',
  'charge.failed',
  'charge.unknown',
  'charge.requires_action',
];

/** A value typed as one of the results although its `errorCode` is not a ProviderErrorCode. */
const bogus = <T>(value: unknown): T => value as T;

describe('ProviderErrorCode through the configurator (#53)', () => {
  let provider: ScriptedProvider;
  let checkout: CheckoutConfigurator;
  let events: [CheckoutEventName, CheckoutEventPayload][];

  beforeEach(() => {
    provider = new ScriptedProvider();
    checkout = new CheckoutConfigurator().registerProvider(provider);
    events = [];
    for (const name of ALL_EVENTS) {
      checkout.events.on(name, (payload) => {
        events.push([name, payload]);
      });
    }
  });

  describe('chargeMandate', () => {
    it.each([F, U])('an unknown charge keeps %s, and charge.unknown carries it in data.errorCode', async (errorCode) => {
      provider.chargeResult = () => ({ status: 'unknown', verified: false, chargeRef: CHARGE_REF, errorCode, error: 'auth' });
      expect(await checkout.chargeMandate('scripted', mandate, charge)).toEqual({
        status: 'unknown',
        verified: false,
        chargeRef: CHARGE_REF,
        errorCode,
        error: 'auth',
      });
      expect(events.map(([name]) => name)).toEqual(['charge.unknown']);
      expect(events[0][1].data.errorCode).toBe(errorCode);
    });

    it.each([F, U])('a failed charge keeps %s too (only succeeded drops a code)', async (errorCode) => {
      provider.chargeResult = () => ({ status: 'failed', verified: true, chargeRef: CHARGE_REF, errorCode, error: 'declined' });
      const result = await checkout.chargeMandate('scripted', mandate, charge);
      expect(result.errorCode).toBe(errorCode);
      expect(events[0][1].data.errorCode).toBe(errorCode);
    });

    it.each([F, U])('a verified succeeded drops %s', async (errorCode) => {
      provider.chargeResult = () => ({
        status: 'succeeded',
        verified: true,
        chargeRef: CHARGE_REF,
        providerPaymentId: 'PAY-1',
        amount: 19.9,
        currency: 'EUR',
        errorCode,
      });
      const result = await checkout.chargeMandate('scripted', mandate, charge);
      expect(result.status).toBe('succeeded');
      expect('errorCode' in result).toBe(false);
      expect(events.map(([name]) => name)).toEqual(['charge.succeeded']);
      expect(events[0][1].data.errorCode).toBeUndefined();
    });

    it("a code that is not a ChargeErrorCode ('X') is still dropped", async () => {
      provider.chargeResult = () =>
        bogus<ChargeResult>({ status: 'unknown', verified: false, chargeRef: CHARGE_REF, errorCode: 'X' });
      expect('errorCode' in (await checkout.chargeMandate('scripted', mandate, charge))).toBe(false);
    });
  });

  describe('confirmMandate: only an unverified outcome keeps a top-level ProviderErrorCode', () => {
    const unknownFirstCharge = (errorCode?: string): ChargeResult =>
      bogus<ChargeResult>({ status: 'unknown', verified: false, chargeRef: pending.orderId, error: 'auth', ...(errorCode ? { errorCode } : {}) });

    it.each([F, U])('an unverified outcome keeps %s at the top level; its first charge has no errorCode key', async (errorCode) => {
      provider.outcome = () => ({
        success: false,
        verified: false,
        terminal: false,
        errorCode,
        error: 'PayPal order could not be read (HTTP 401)',
        firstCharge: unknownFirstCharge(errorCode),
      });
      const outcome = await checkout.confirmMandate('scripted', pending, {});
      expect(outcome).toMatchObject({ success: false, verified: false, terminal: false, errorCode });
      expect('errorCode' in outcome.firstCharge).toBe(false);
      expect(events).toEqual([]);
    });

    it("an unverified outcome drops 'X'", async () => {
      provider.outcome = () =>
        bogus<MandateSetupOutcome>({
          success: false,
          verified: false,
          terminal: false,
          errorCode: 'X',
          firstCharge: unknownFirstCharge(),
        });
      expect('errorCode' in (await checkout.confirmMandate('scripted', pending, {}))).toBe(false);
    });

    it.each([F, 'X'])('a verified terminal success drops %s', async (errorCode) => {
      provider.outcome = () =>
        bogus<MandateSetupOutcome>({
          success: true,
          verified: true,
          terminal: true,
          errorCode,
          mandate: { ...mandate },
          firstCharge: {
            status: 'succeeded',
            verified: true,
            chargeRef: pending.orderId,
            providerPaymentId: 'PAY-FIRST',
            amount: 19.9,
            currency: 'EUR',
          },
        });
      const outcome = await checkout.confirmMandate('scripted', pending, {});
      expect(outcome).toMatchObject({ success: true, verified: true, terminal: true });
      expect('errorCode' in outcome).toBe(false);
    });

    it.each([U, 'X'])('a verified non-terminal failure drops %s', async (errorCode) => {
      provider.outcome = () =>
        bogus<MandateSetupOutcome>({
          success: false,
          verified: true,
          terminal: false,
          errorCode,
          error: 'ORDER_NOT_APPROVED',
          firstCharge: { status: 'unknown', verified: true, chargeRef: pending.orderId, error: 'ORDER_NOT_APPROVED' },
        });
      const outcome = await checkout.confirmMandate('scripted', pending, {});
      expect(outcome).toMatchObject({ success: false, verified: true, terminal: false, error: 'ORDER_NOT_APPROVED' });
      expect('errorCode' in outcome).toBe(false);
    });

    it('a verified outcome that does not match the pending setup (made unverified by the configurator) drops it', async () => {
      provider.outcome = () => ({
        success: false,
        verified: true,
        terminal: true,
        errorCode: F,
        firstCharge: { status: 'failed', verified: true, chargeRef: 'ANOTHER-ORDER' },
      });
      const outcome = await checkout.confirmMandate('scripted', pending, {});
      expect(outcome).toMatchObject({ verified: false, terminal: false, error: 'Mandate outcome does not match the pending setup' });
      expect('errorCode' in outcome).toBe(false);
    });
  });

  describe('getMandate: kept only on an unknown status', () => {
    it.each([F, U])('unknown keeps %s', async (errorCode) => {
      provider.status = () => ({ status: 'unknown', verified: false, errorCode, raw: { name: 'AUTHENTICATION_FAILURE' } });
      expect(await checkout.getMandate('scripted', mandate)).toEqual({
        status: 'unknown',
        verified: false,
        errorCode,
        raw: { name: 'AUTHENTICATION_FAILURE' },
      });
    });

    it("unknown drops 'X'", async () => {
      provider.status = () => bogus<MandateStatusResult>({ status: 'unknown', verified: false, errorCode: 'X' });
      expect(await checkout.getMandate('scripted', mandate)).toStrictEqual({ status: 'unknown', verified: false });
    });

    it.each([
      ['active', F],
      ['revoked', U],
    ] as const)('%s drops %s', async (status, errorCode) => {
      provider.status = () => ({ status, verified: true, errorCode });
      expect(await checkout.getMandate('scripted', mandate)).toStrictEqual({ status, verified: true });
    });
  });

  describe('revokeMandate: kept only with revokedAtProvider: false; mandate.revoked is unchanged', () => {
    it.each([F, U])('revokedAtProvider: false keeps %s', async (errorCode) => {
      provider.revoke = () => ({ revokedAtProvider: false, errorCode, error: 'PayPal could not delete the vault token (HTTP 401)' });
      expect(await checkout.revokeMandate('scripted', mandate)).toEqual({
        revokedAtProvider: false,
        errorCode,
        error: 'PayPal could not delete the vault token (HTTP 401)',
      });
      expect(events.map(([name]) => name)).toEqual(['mandate.revoked']);
      const [, payload] = events[0];
      expect(payload.data).toStrictEqual({ mandateRef: 'MNDT0000000001', revokedAtProvider: false });
      expect('errorCode' in payload).toBe(false);
    });

    it("revokedAtProvider: false drops 'X'", async () => {
      provider.revoke = () => bogus<MandateRevokeResult>({ revokedAtProvider: false, errorCode: 'X' });
      expect(await checkout.revokeMandate('scripted', mandate)).toStrictEqual({ revokedAtProvider: false });
    });

    it('revokedAtProvider: true drops a ProviderErrorCode', async () => {
      provider.revoke = () => ({ revokedAtProvider: true, errorCode: F });
      expect(await checkout.revokeMandate('scripted', mandate)).toStrictEqual({ revokedAtProvider: true });
    });
  });

  describe('getCharge: kept only on a lookup the provider reported unknown', () => {
    it.each([F, U])('unknown keeps %s', async (errorCode) => {
      provider.lookup = () => ({ status: 'unknown', verified: false, chargeRef: CHARGE_REF, errorCode, error: 'auth' });
      expect(await checkout.getCharge('scripted', CHARGE_REF)).toEqual({
        status: 'unknown',
        verified: false,
        chargeRef: CHARGE_REF,
        errorCode,
        error: 'auth',
      });
    });

    it('an unrecognised status (made unknown) keeps it', async () => {
      provider.lookup = () => bogus<ChargeLookupResult>({ status: 'error', verified: false, chargeRef: CHARGE_REF, errorCode: U });
      expect(await checkout.getCharge('scripted', CHARGE_REF)).toMatchObject({ status: 'unknown', errorCode: U });
    });

    it("unknown drops 'X'", async () => {
      provider.lookup = () => bogus<ChargeLookupResult>({ status: 'unknown', verified: false, chargeRef: CHARGE_REF, errorCode: 'X' });
      expect('errorCode' in (await checkout.getCharge('scripted', CHARGE_REF))).toBe(false);
    });

    it.each([
      ['absent', F],
      ['succeeded', U],
      ['failed', F],
      ['pending', U],
    ] as const)('a verified %s drops %s', async (status, errorCode) => {
      provider.lookup = () => ({ status, verified: true, chargeRef: CHARGE_REF, errorCode });
      const result = await checkout.getCharge('scripted', CHARGE_REF);
      expect(result.status).toBe(status);
      expect('errorCode' in result).toBe(false);
    });

    it('an unverified succeeded (made unknown: an answer, not a failure) drops it', async () => {
      provider.lookup = () => ({ status: 'succeeded', verified: false, chargeRef: CHARGE_REF, errorCode: F });
      const result = await checkout.getCharge('scripted', CHARGE_REF);
      expect(result).toMatchObject({ status: 'unknown', error: 'Charge lookup could not be verified' });
      expect('errorCode' in result).toBe(false);
    });
  });

  describe('createMandate: kept only on a failed start', () => {
    it.each([F, U])('a failed start keeps %s', async (errorCode) => {
      provider.start = () => ({ success: false, errorCode, error: 'PayPal refused the setup (HTTP 401)' });
      expect(await checkout.createMandate('scripted', setupRequest)).toEqual({
        success: false,
        errorCode,
        error: 'PayPal refused the setup (HTTP 401)',
      });
      expect(events).toEqual([]);
    });

    it("a failed start drops 'X'", async () => {
      provider.start = () => bogus<MandateSetupStart>({ success: false, errorCode: 'X', error: 'refused' });
      expect('errorCode' in (await checkout.createMandate('scripted', setupRequest))).toBe(false);
    });

    it('a successful start drops a ProviderErrorCode', async () => {
      provider.start = () => ({
        success: true,
        errorCode: F,
        approvalUrl: 'https://pay.test/approve',
        pending: { ...pending },
      });
      const start = await checkout.createMandate('scripted', setupRequest);
      expect(start).toMatchObject({ success: true, approvalUrl: 'https://pay.test/approve', pending });
      expect('errorCode' in start).toBe(false);
    });

    it('a successful start whose pending does not match the request (made a failure) drops it', async () => {
      provider.start = () => ({ success: true, errorCode: U, pending: { ...pending, orderId: 'ANOTHER-ORDER' } });
      const start = await checkout.createMandate('scripted', setupRequest);
      expect(start).toMatchObject({ success: false, error: 'Mandate setup does not match the request' });
      expect('errorCode' in start).toBe(false);
    });
  });

  describe('PaymentResult passes through unchanged; the payment.* event payloads carry no errorCode', () => {
    const failure = (): PaymentResult => ({ success: false, errorCode: F, error: 'PayPal authentication failed (HTTP 401)' });

    it('createPayment, executePayment, handleRedirect, getPaymentDetails and refundPayment keep it', async () => {
      provider.payment = failure;
      const request: PaymentRequest = { amount: 19.9, currency: 'EUR', returnUrl: 'https://shop.test/r', cancelUrl: 'https://shop.test/c' };
      for (const result of [
        await checkout.createPayment('scripted', request),
        await checkout.executePayment('scripted', 'PAY-1'),
        await checkout.handleRedirect('scripted', { token: 'PAY-1' }),
        await checkout.getPaymentDetails('scripted', 'PAY-1'),
        await checkout.refundPayment('scripted', 'PAY-1', 5),
      ]) {
        expect(result).toMatchObject({ success: false, errorCode: F, error: 'PayPal authentication failed (HTTP 401)' });
      }
      expect(events.map(([name]) => name)).toEqual(['payment.failed', 'payment.failed', 'payment.failed', 'payment.refunded']);
      for (const [, payload] of events) {
        expect('errorCode' in payload).toBe(false);
        expect(payload.data).toBeUndefined();
      }
    });
  });
});
