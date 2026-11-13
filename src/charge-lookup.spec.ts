import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { CheckoutConfigurator } from './checkout-configurator';
import { BasePaymentProvider } from './abstract/base-payment-provider.abstract';
import { PaymentRequest } from './models/payment-request.model';
import { PaymentResult } from './models/payment-result.model';
import { CheckoutError } from './models/errors';
import { CheckoutEventName } from './events/checkout-event-bus';
import { Mandate } from './models/mandate.model';
import type { ChargeLookupOptions, ChargeLookupResult } from './models/mandate.model';
import { isChargeLookupProvider } from './index';
import { NexiProvider } from './providers/nexi/nexi.provider';
import { PayPalProvider } from './providers/paypal/paypal.provider';
import { SatispayProvider } from './providers/satispay/satispay.provider';
import { createCheckoutRouter } from './adapters/express';

// Public charge lookup through the configurator (#40) and its refundedAmount normalization (#41).

const CHARGE = 'SUB-0001-2026-12';

/** Copy of the DummyProvider of checkout-configurator.spec.ts (importing a spec would run it). */
class DummyProvider extends BasePaymentProvider {
  name = 'dummy';
  flow = 'redirect' as const;

  async createPayment(req: PaymentRequest): Promise<PaymentResult> {
    return { success: true, paymentId: 'dummy-123', status: 'CREATED', raw: req };
  }
  async executePayment(id: string, data?: any): Promise<PaymentResult> {
    return { success: true, verified: true, paymentId: id, status: 'COMPLETED', raw: data };
  }
  async getPaymentDetails(id: string): Promise<PaymentResult> {
    return { success: true, paymentId: id, status: 'DETAILS', raw: {} };
  }
  async refundPayment(id: string, amount?: number): Promise<PaymentResult> {
    return { success: true, paymentId: id, status: 'REFUNDED', raw: { amount } };
  }
}

/** A provider with the optional charge lookup capability. `next` scripts its result. */
class LookupDummyProvider extends DummyProvider {
  name = 'lookup';
  calls: [string, ChargeLookupOptions | undefined][] = [];
  next: (chargeRef: string, options?: ChargeLookupOptions) => unknown = (chargeRef) => ({
    status: 'absent',
    verified: true,
    chargeRef,
  });

  async getCharge(chargeRef: string, options?: ChargeLookupOptions): Promise<ChargeLookupResult> {
    this.calls.push([chargeRef, options]);
    return this.next(chargeRef, options) as ChargeLookupResult;
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

function lookupMandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    provider: 'lookup',
    mandateRef: 'MNDT0000000001',
    providerMandateId: 'vault-tok-0001',
    status: 'active',
    createdAt: '2026-12-01T10:15:00.000Z',
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<CheckoutError> {
  try {
    await promise;
  } catch (err) {
    return err as CheckoutError;
  }
  throw new Error('expected a rejection');
}

describe('Charge lookup through the configurator (#40)', () => {
  let checkout: CheckoutConfigurator;
  let lookup: LookupDummyProvider;

  beforeEach(() => {
    lookup = new LookupDummyProvider();
    checkout = new CheckoutConfigurator()
      .registerProvider(new DummyProvider())
      .registerProvider(lookup)
      .registerProvider(new NexiProvider({ merchantId: 'ALIAS_TEST_01', macKey: 'TEST_SECRET_KEY_0001' }))
      .registerProvider(new PayPalProvider({ clientId: 'id', clientSecret: 'secret' }))
      .registerProvider(new SatispayProvider({ keyId: 'key', privateKey: 'unused', webhookPublicKey: 'unused' }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('supportsChargeLookup and isChargeLookupProvider', () => {
    it('is true for nexi and paypal, false for satispay and the plain DummyProvider', () => {
      expect(checkout.supportsChargeLookup('nexi')).toBe(true);
      expect(checkout.supportsChargeLookup('paypal')).toBe(true);
      expect(checkout.supportsChargeLookup('satispay')).toBe(false);
      expect(checkout.supportsChargeLookup('dummy')).toBe(false);
      expect(checkout.supportsChargeLookup('lookup')).toBe(true);
    });

    it('throws PROVIDER_NOT_FOUND for an unregistered provider, like supportsMandates', () => {
      let err: unknown;
      try {
        checkout.supportsChargeLookup('stripe');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CheckoutError);
      expect((err as CheckoutError).code).toBe('PROVIDER_NOT_FOUND');
    });

    it('isChargeLookupProvider is true only for a getCharge function', () => {
      expect(isChargeLookupProvider(lookup)).toBe(true);
      expect(isChargeLookupProvider({ getCharge: async () => undefined })).toBe(true);
      expect(isChargeLookupProvider(new DummyProvider())).toBe(false);
      expect(isChargeLookupProvider({ getCharge: 'yes' })).toBe(false);
      expect(isChargeLookupProvider(null)).toBe(false);
      expect(isChargeLookupProvider(undefined)).toBe(false);
      expect(isChargeLookupProvider('getCharge')).toBe(false);
    });
  });

  describe('unsupported providers', () => {
    it("getCharge('satispay', CHARGE) throws CHARGE_LOOKUP_NOT_SUPPORTED", async () => {
      const err = await rejection(checkout.getCharge('satispay', CHARGE));
      expect(err).toBeInstanceOf(CheckoutError);
      expect(err.code).toBe('CHARGE_LOOKUP_NOT_SUPPORTED');
      expect(err.provider).toBe('satispay');
      expect((await rejection(checkout.getCharge('dummy', CHARGE))).code).toBe('CHARGE_LOOKUP_NOT_SUPPORTED');
    });

    it('an unregistered provider throws PROVIDER_NOT_FOUND', async () => {
      expect((await rejection(checkout.getCharge('stripe', CHARGE))).code).toBe('PROVIDER_NOT_FOUND');
    });

    it('sendError maps CHARGE_LOOKUP_NOT_SUPPORTED to 422', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const thrown = await rejection(checkout.getCharge('satispay', CHARGE));
      // There is no getCharge route: the app's own code reaches sendError through a routed method
      vi.spyOn(checkout, 'handleWebhook').mockImplementation(() => {
        throw thrown;
      });
      const app = express();
      app.use(express.json());
      app.use('/checkout', createCheckoutRouter(checkout, { buildPaymentRequest: () => null }));
      const response = await request(app).post('/checkout/satispay/webhook').send({});
      expect(response.status).toBe(422);
      expect(response.body).toEqual({
        success: false,
        error: thrown.message,
        code: 'CHARGE_LOOKUP_NOT_SUPPORTED',
      });
    });
  });

  describe('validation, before any provider call', () => {
    it.each([['x'], ['SUB_0001'], ['x'.repeat(31)]])('chargeRef %j is INVALID_MANDATE_REQUEST', async (chargeRef) => {
      const err = await rejection(checkout.getCharge('lookup', chargeRef));
      expect(err).toBeInstanceOf(CheckoutError);
      expect(err.code).toBe('INVALID_MANDATE_REQUEST');
      expect(lookup.calls).toHaveLength(0);
    });

    it("since: 'yesterday' is INVALID_MANDATE_REQUEST", async () => {
      const err = await rejection(checkout.getCharge('lookup', CHARGE, { since: 'yesterday' }));
      expect(err.code).toBe('INVALID_MANDATE_REQUEST');
      expect(lookup.calls).toHaveLength(0);
    });

    it('an unparseable or non-string until is INVALID_MANDATE_REQUEST', async () => {
      for (const until of ['tomorrow', 1767225600000 as unknown as string]) {
        const err = await rejection(checkout.getCharge('lookup', CHARGE, { since: '2026-11-12T01:00:00.000Z', until }));
        expect(err.code).toBe('INVALID_MANDATE_REQUEST');
      }
      expect(lookup.calls).toHaveLength(0);
    });

    it('until earlier than since is INVALID_MANDATE_REQUEST', async () => {
      const err = await rejection(
        checkout.getCharge('lookup', CHARGE, { since: '2026-11-12T01:00:00.000Z', until: '2026-11-12T00:59:59.999Z' }),
      );
      expect(err.code).toBe('INVALID_MANDATE_REQUEST');
      expect(lookup.calls).toHaveLength(0);
    });

    it('a mandate of another provider is INVALID_MANDATE_REQUEST', async () => {
      const err = await rejection(checkout.getCharge('lookup', CHARGE, { mandate: lookupMandate({ provider: 'nexi' }) }));
      expect(err.code).toBe('INVALID_MANDATE_REQUEST');
      expect(lookup.calls).toHaveLength(0);
    });

    it('valid options reach the provider: since, until (equal to since) and a mandate of this provider', async () => {
      const options = {
        since: '2026-11-12T01:00:00.000Z',
        until: '2026-11-12T01:00:00.000Z',
        mandate: lookupMandate(),
      };
      const result = await checkout.getCharge('lookup', CHARGE, options);
      expect(result).toEqual({ status: 'absent', verified: true, chargeRef: CHARGE });
      expect(lookup.calls).toHaveLength(1);
      expect(lookup.calls[0][0]).toBe(CHARGE);
      expect(lookup.calls[0][1]).toEqual(options);
    });

    it('no options reach the provider as no constraint', async () => {
      await checkout.getCharge('lookup', CHARGE);
      expect(lookup.calls).toHaveLength(1);
      expect(lookup.calls[0][1] ?? {}).toEqual({});
    });
  });

  describe('normalization (fail closed)', () => {
    it("an unverified 'succeeded' becomes unknown without the payment fields", async () => {
      lookup.next = () => ({ status: 'succeeded', verified: false, providerPaymentId: 'P', amount: 1 });
      const result = await checkout.getCharge('lookup', CHARGE);
      expect(result).toEqual({
        status: 'unknown',
        verified: false,
        chargeRef: CHARGE,
        error: 'Charge lookup could not be verified',
      });
      expect('providerPaymentId' in result).toBe(false);
      expect('amount' in result).toBe(false);
    });

    it('drops currency, providerStatus and providerState of an unverified result too', async () => {
      lookup.next = () => ({
        status: 'succeeded',
        verified: 'true',
        providerPaymentId: 'P',
        amount: 19.9,
        currency: 'EUR',
        providerStatus: 'Rimborsato',
        providerState: 'refunded',
        raw: { stato: 'Rimborsato' },
      });
      const result = await checkout.getCharge('lookup', CHARGE);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.error).toBe('Charge lookup could not be verified');
      for (const key of ['providerPaymentId', 'amount', 'currency', 'providerStatus', 'providerState']) {
        expect(key in result).toBe(false);
      }
      // raw is the provider's answer: kept, as for chargeMandate
      expect(result.raw).toEqual({ stato: 'Rimborsato' });
    });

    it("{ status: 'absent' } without verified is unknown", async () => {
      lookup.next = () => ({ status: 'absent' });
      const result = await checkout.getCharge('lookup', CHARGE);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.chargeRef).toBe(CHARGE);
    });

    it("{ status: 'weird', verified: true } is unknown and unverified", async () => {
      lookup.next = () => ({ status: 'weird', verified: true, providerPaymentId: 'P' });
      const result = await checkout.getCharge('lookup', CHARGE);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect('providerPaymentId' in result).toBe(false);
    });

    it("the provider's own unknown is never verified", async () => {
      lookup.next = (chargeRef) => ({ status: 'unknown', verified: true, chargeRef, error: 'timeout' });
      expect(await checkout.getCharge('lookup', CHARGE)).toEqual({
        status: 'unknown',
        verified: false,
        chargeRef: CHARGE,
        error: 'timeout',
      });
    });

    it.each(['failed', 'pending', 'absent'] as const)('a verified %s passes through', async (status) => {
      lookup.next = (chargeRef) => ({ status, verified: true, chargeRef, providerStatus: 'X' });
      expect(await checkout.getCharge('lookup', CHARGE)).toEqual({
        status,
        verified: true,
        chargeRef: CHARGE,
        providerStatus: 'X',
      });
    });

    it("a different chargeRef in the provider's result is replaced by the request's", async () => {
      lookup.next = () => ({ status: 'succeeded', verified: true, chargeRef: 'SUB-9999-2026-12', amount: 19.9 });
      const result = await checkout.getCharge('lookup', CHARGE);
      expect(result.chargeRef).toBe(CHARGE);
      expect(result.status).toBe('succeeded');
    });

    it("returns a new object and never mutates the provider's", async () => {
      const providerResult = {
        status: 'succeeded',
        verified: false,
        chargeRef: 'OTHER-REF',
        providerPaymentId: 'P',
        amount: 1,
      };
      lookup.next = () => providerResult;
      const result = await checkout.getCharge('lookup', CHARGE);
      expect(result).not.toBe(providerResult);
      expect(providerResult).toEqual({
        status: 'succeeded',
        verified: false,
        chargeRef: 'OTHER-REF',
        providerPaymentId: 'P',
        amount: 1,
      });

      const verified = { status: 'succeeded', verified: true, chargeRef: CHARGE, amount: 19.9 };
      lookup.next = () => verified;
      expect(await checkout.getCharge('lookup', CHARGE)).not.toBe(verified);
    });

    it('a non-object result is unknown', async () => {
      for (const value of [undefined, null, 'succeeded', 42]) {
        lookup.next = () => value;
        expect(await checkout.getCharge('lookup', CHARGE)).toEqual({
          status: 'unknown',
          verified: false,
          chargeRef: CHARGE,
          error: 'Provider returned no lookup result',
        });
      }
    });

    it('a provider that throws gives unknown with raw reduced to { name, message }', async () => {
      lookup.next = () => {
        throw Object.assign(new Error('boom'), { request: { headers: { authorization: 'Bearer SECRET' } } });
      };
      const result = await checkout.getCharge('lookup', CHARGE);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.chargeRef).toBe(CHARGE);
      expect(result.error).toBe('Charge lookup failed: the provider call failed');
      expect(result.raw).toEqual({ name: 'Error', message: 'boom' });
      expect(JSON.stringify(result)).not.toContain('Bearer');
    });

    it('a provider that rejects with a non-Error gives unknown without raw', async () => {
      lookup.getCharge = () => Promise.reject('down');
      const result = await checkout.getCharge('lookup', CHARGE);
      expect(result).toEqual({
        status: 'unknown',
        verified: false,
        chargeRef: CHARGE,
        error: 'Charge lookup failed: the provider call failed',
      });
    });

    it('getCharge emits no event: a listener on every CheckoutEventName is never called', async () => {
      const listener = vi.fn();
      for (const name of ALL_EVENTS) checkout.events.on(name, listener);
      const emit = vi.spyOn(checkout.events, 'emit');

      lookup.next = (chargeRef) => ({ status: 'succeeded', verified: true, chargeRef, amount: 19.9, currency: 'EUR' });
      await checkout.getCharge('lookup', CHARGE);
      lookup.next = () => ({ status: 'succeeded', verified: false });
      await checkout.getCharge('lookup', CHARGE);
      lookup.next = () => {
        throw new Error('boom');
      };
      await checkout.getCharge('lookup', CHARGE);

      expect(listener).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('refundedAmount (#41)', () => {
    it("{ status: 'pending', verified: true, refundedAmount: 1 } has no refundedAmount", async () => {
      lookup.next = (chargeRef) => ({ status: 'pending', verified: true, chargeRef, refundedAmount: 1 });
      const result = await checkout.getCharge('lookup', CHARGE);
      expect(result.status).toBe('pending');
      expect('refundedAmount' in result).toBe(false);
    });

    it.each([[-1], [NaN], [Infinity], ['5']])('a verified succeeded with refundedAmount %j has no field', async (value) => {
      lookup.next = (chargeRef) => ({ status: 'succeeded', verified: true, chargeRef, refundedAmount: value });
      const result = await checkout.getCharge('lookup', CHARGE);
      expect(result.status).toBe('succeeded');
      expect('refundedAmount' in result).toBe(false);
    });

    it('a verified succeeded keeps refundedAmount 0 and a positive amount', async () => {
      lookup.next = (chargeRef) => ({ status: 'succeeded', verified: true, chargeRef, refundedAmount: 0 });
      const zero = await checkout.getCharge('lookup', CHARGE);
      expect(zero.refundedAmount).toBe(0);
      expect('refundedAmount' in zero).toBe(true);

      lookup.next = (chargeRef) => ({ status: 'succeeded', verified: true, chargeRef, refundedAmount: 9.99 });
      expect((await checkout.getCharge('lookup', CHARGE)).refundedAmount).toBe(9.99);
    });

    it('an unverified result has no refundedAmount, together with the other fields', async () => {
      lookup.next = (chargeRef) => ({
        status: 'succeeded',
        verified: false,
        chargeRef,
        providerPaymentId: 'P',
        amount: 19.9,
        refundedAmount: 0,
      });
      const result = await checkout.getCharge('lookup', CHARGE);
      expect(result.status).toBe('unknown');
      expect('refundedAmount' in result).toBe(false);
      expect('providerPaymentId' in result).toBe(false);
      expect('amount' in result).toBe(false);
    });
  });
});
