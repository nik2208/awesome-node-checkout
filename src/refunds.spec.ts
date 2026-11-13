import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { CheckoutConfigurator } from './checkout-configurator';
import { BasePaymentProvider } from './abstract/base-payment-provider.abstract';
import { PaymentRequest } from './models/payment-request.model';
import { PaymentResult } from './models/payment-result.model';
import { CheckoutError } from './models/errors';
import type { RefundOptions } from './models/refund.model';
import * as index from './index';
import { NexiProvider } from './providers/nexi/nexi.provider';
import { PayPalProvider } from './providers/paypal/paypal.provider';
import { SatispayProvider } from './providers/satispay/satispay.provider';
import { createCheckoutRouter } from './adapters/express';

// Refund idempotency keys through the configurator (#44). The provider requests are in the
// provider specs (paypal.mandates, nexi.mandates, satispay.mandates).

/**
 * Copy of the DummyProvider of checkout-configurator.spec.ts (importing a spec would run it): a
 * provider written for 2.1, with the two-parameter refundPayment and no supportsRefundIdempotency.
 */
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

/**
 * A provider written for 2.1 whose refundPayment already had a third parameter of its own, widened to accept
 * RefundOptions too so that it compiles against 2.2 (README "Custom Provider"). No supportsRefundIdempotency.
 */
class ReasonProvider extends DummyProvider {
  name = 'reason';

  async refundPayment(
    id: string,
    amount?: number,
    reason?: 'duplicate' | 'fraudulent' | RefundOptions,
  ): Promise<PaymentResult> {
    return { success: true, paymentId: id, status: 'REFUNDED', raw: { amount, reason } };
  }
}

const KEY = 'refund-ORD-001-R1';

async function rejection(promise: Promise<unknown>): Promise<CheckoutError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CheckoutError);
    return err as CheckoutError;
  }
  throw new Error('expected a rejection');
}

describe('Refund idempotency keys: configurator (#44)', () => {
  const originalFetch = globalThis.fetch;
  let checkout: CheckoutConfigurator;
  let paypal: PayPalProvider;
  let nexi: NexiProvider;
  let dummy: DummyProvider;
  let paypalRefund: ReturnType<typeof vi.fn>;
  let dummyRefund: ReturnType<typeof vi.spyOn>;
  let events: any[];

  beforeEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = vi.fn() as any;
    checkout = new CheckoutConfigurator();
    paypal = new PayPalProvider({ clientId: 'a', clientSecret: 'b' });
    nexi = new NexiProvider({ merchantId: 'ALIAS_TEST_01', macKey: 'TEST_SECRET_KEY_0001' });
    dummy = new DummyProvider();
    checkout.registerProvider(paypal).registerProvider(nexi).registerProvider(dummy);
    // Declares the three parameters, as an IRefundIdempotencyProvider must (isRefundIdempotencyProvider reads length)
    paypalRefund = vi.fn(async (paymentId: string, _amount?: number, _options?: RefundOptions) => ({
      success: true,
      verified: true,
      paymentId: `REFUND-${paymentId}`,
      status: 'COMPLETED',
    }));
    (paypal as any).refundPayment = paypalRefund;
    dummyRefund = vi.spyOn(dummy, 'refundPayment');
    events = [];
    checkout.events.on('payment.refunded', (payload) => {
      events.push(payload);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('exports and capability', () => {
    it('REFUND_IDEMPOTENCY_KEY_PATTERN is /^[A-Za-z0-9_-]{8,64}$/', () => {
      const pattern = (index as Record<string, unknown>).REFUND_IDEMPOTENCY_KEY_PATTERN as RegExp;
      expect(pattern).toBeInstanceOf(RegExp);
      expect(pattern.source).toBe('^[A-Za-z0-9_-]{8,64}$');
      expect(pattern.flags).toBe('');
      expect(pattern.test('refund-SUB-0001-R1')).toBe(true);
      expect(pattern.test('x'.repeat(8))).toBe(true);
      expect(pattern.test('x'.repeat(64))).toBe(true);
      expect(pattern.test('x'.repeat(7))).toBe(false);
      expect(pattern.test('x'.repeat(65))).toBe(false);
    });

    it('supportsRefundIdempotency: PayPal and Satispay true; Nexi and a provider written for 2.1 not', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(new PayPalProvider({ clientId: 'a', clientSecret: 'b' }).supportsRefundIdempotency).toBe(true);
      expect(new SatispayProvider({ keyId: 'k', privateKey: 'unused' }).supportsRefundIdempotency).toBe(true);
      expect(nexi.supportsRefundIdempotency).not.toBe(true);
      expect((dummy as { supportsRefundIdempotency?: boolean }).supportsRefundIdempotency).toBeUndefined();
    });
  });

  describe('validation (fail closed, before any provider call or event)', () => {
    it.each([
      ['short', 'short'],
      ['has space 1', 'has space 1'],
      ["'x'.repeat(65)", 'x'.repeat(65)],
      ['123 (cast)', 123 as unknown as string],
    ])('idempotencyKey %s throws INVALID_REFUND_REQUEST', async (_label, idempotencyKey) => {
      for (const provider of ['paypal', 'nexi', 'dummy']) {
        const err = await rejection(checkout.refundPayment(provider, 'ORD-001', 5, { idempotencyKey }));
        expect(err.code).toBe('INVALID_REFUND_REQUEST');
        expect(err.provider).toBe(provider);
      }
      expect(paypalRefund).not.toHaveBeenCalled();
      expect(dummyRefund).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    it("refundPayment('nexi', 'ORD-001', 5, { idempotencyKey }) throws REFUND_IDEMPOTENCY_NOT_SUPPORTED without a request or an event", async () => {
      const err = await rejection(checkout.refundPayment('nexi', 'ORD-001', 5, { idempotencyKey: KEY }));
      expect(err.code).toBe('REFUND_IDEMPOTENCY_NOT_SUPPORTED');
      expect(err.provider).toBe('nexi');
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    it('a provider written for 2.1 (no supportsRefundIdempotency) throws REFUND_IDEMPOTENCY_NOT_SUPPORTED too', async () => {
      const err = await rejection(checkout.refundPayment('dummy', 'PAY-1', 5, { idempotencyKey: KEY }));
      expect(err.code).toBe('REFUND_IDEMPOTENCY_NOT_SUPPORTED');
      expect(err.provider).toBe('dummy');
      expect(dummyRefund).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    it('options that are not an object throw INVALID_REFUND_REQUEST', async () => {
      const err = await rejection(checkout.refundPayment('paypal', 'ORD', 5, KEY as unknown as RefundOptions));
      expect(err.code).toBe('INVALID_REFUND_REQUEST');
      expect(paypalRefund).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    it('an unregistered provider still throws PROVIDER_NOT_FOUND', async () => {
      expect((await rejection(checkout.refundPayment('stripe', 'ORD', 5, { idempotencyKey: KEY }))).code).toBe(
        'PROVIDER_NOT_FOUND',
      );
    });
  });

  describe('provider call', () => {
    it("refundPayment('paypal', 'ORD', 5) calls the provider with exactly ('ORD', 5)", async () => {
      const result = await checkout.refundPayment('paypal', 'ORD', 5);
      expect(paypalRefund).toHaveBeenCalledTimes(1);
      expect(paypalRefund.mock.calls[0]).toHaveLength(2);
      expect(paypalRefund.mock.calls[0]).toEqual(['ORD', 5]);
      expect(result).toMatchObject({ success: true, verified: true, paymentId: 'REFUND-ORD' });
    });

    it("refundPayment('paypal', 'ORD') (full refund) calls the provider with exactly ('ORD', undefined)", async () => {
      await checkout.refundPayment('paypal', 'ORD');
      expect(paypalRefund.mock.calls[0]).toHaveLength(2);
      expect(paypalRefund.mock.calls[0]).toEqual(['ORD', undefined]);
    });

    it('null options are no options: the provider gets two arguments', async () => {
      await checkout.refundPayment('paypal', 'ORD', 5, null as unknown as RefundOptions);
      expect(paypalRefund.mock.calls[0]).toHaveLength(2);
    });

    it('with a valid key, the provider gets (paymentId, amount, { idempotencyKey }), with the known field only', async () => {
      await checkout.refundPayment('paypal', 'ORD', 5, { idempotencyKey: KEY });
      await checkout.refundPayment('paypal', 'ORD', 5, { idempotencyKey: KEY, extra: 'ignored' } as RefundOptions);
      expect(paypalRefund.mock.calls).toEqual([
        ['ORD', 5, { idempotencyKey: KEY }],
        ['ORD', 5, { idempotencyKey: KEY }],
      ]);
    });

    it('options without a key need no provider support, and go only to a provider that supports keys', async () => {
      await checkout.refundPayment('paypal', 'ORD', 5, {});
      await checkout.refundPayment('dummy', 'PAY-1', 5, {});
      expect(paypalRefund.mock.calls).toEqual([['ORD', 5, {}]]);
      // A provider written for 2.1 gets the 2.1 call
      expect(dummyRefund.mock.calls).toEqual([['PAY-1', 5]]);
      expect(dummyRefund.mock.calls[0]).toHaveLength(2);
    });

    it('a provider written for 2.1 with a third parameter of its own never gets the options in it', async () => {
      const reason = new ReasonProvider();
      checkout.registerProvider(reason);
      const reasonRefund = vi.spyOn(reason, 'refundPayment');
      const result = await checkout.refundPayment('reason', 'PAY-2', 5, {});
      expect(reasonRefund.mock.calls).toEqual([['PAY-2', 5]]);
      expect(reasonRefund.mock.calls[0]).toHaveLength(2);
      expect(result).toMatchObject({ success: true, paymentId: 'PAY-2', status: 'REFUNDED' });
      expect((result.raw as { reason?: unknown }).reason).toBeUndefined();
      // Its own callers keep passing their value
      await expect(reason.refundPayment('PAY-3', 5, 'duplicate')).resolves.toMatchObject({ raw: { reason: 'duplicate' } });
    });

    it('a provider written for 2.1 keeps working without options: same call, same result, same event', async () => {
      const result = await checkout.refundPayment('dummy', 'PAY-1', 5);
      expect(dummyRefund.mock.calls).toEqual([['PAY-1', 5]]);
      expect(result).toEqual({ success: true, paymentId: 'PAY-1', status: 'REFUNDED', raw: { amount: 5 } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ provider: 'dummy', paymentId: 'PAY-1', status: 'REFUNDED', verified: false });
    });

    it('payment.refunded is unchanged with a key: same fields, no key in the payload', async () => {
      await checkout.refundPayment('paypal', 'ORD', 5, { idempotencyKey: KEY });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ provider: 'paypal', paymentId: 'ORD', status: 'COMPLETED', verified: true });
      expect(Object.keys(events[0]).sort()).toEqual(
        ['error', 'orderId', 'paymentId', 'provider', 'raw', 'status', 'timestamp', 'verified'],
      );
      expect(JSON.stringify(events[0])).not.toContain(KEY);
    });
  });

  describe('Express error mapping', () => {
    async function viaRefundRoute(thrown: CheckoutError, provider: string) {
      // The refund route takes no key: the app's own code reaches sendError through a routed method
      vi.spyOn(checkout, 'refundPayment').mockImplementation(async () => {
        throw thrown;
      });
      const app = express();
      app.use(express.json());
      app.use('/checkout', createCheckoutRouter(checkout, { buildPaymentRequest: () => null, refund: {} }));
      return request(app).post(`/checkout/${provider}/refund`).send({ paymentId: 'ORD-001', amount: 5 });
    }

    it('sendError maps REFUND_IDEMPOTENCY_NOT_SUPPORTED to 422', async () => {
      const thrown = await rejection(checkout.refundPayment('nexi', 'ORD-001', 5, { idempotencyKey: KEY }));
      const response = await viaRefundRoute(thrown, 'nexi');
      expect(response.status).toBe(422);
      expect(response.body).toEqual({ success: false, error: thrown.message, code: 'REFUND_IDEMPOTENCY_NOT_SUPPORTED' });
    });

    it('sendError maps INVALID_REFUND_REQUEST to 400', async () => {
      const thrown = await rejection(checkout.refundPayment('paypal', 'ORD-001', 5, { idempotencyKey: 'short' }));
      const response = await viaRefundRoute(thrown, 'paypal');
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ success: false, error: thrown.message, code: 'INVALID_REFUND_REQUEST' });
    });

    it('the refund route still calls refundPayment with (provider, paymentId, amount) only', async () => {
      const spy = vi.spyOn(checkout, 'refundPayment');
      const app = express();
      app.use(express.json());
      app.use('/checkout', createCheckoutRouter(checkout, { buildPaymentRequest: () => null, refund: {} }));
      const response = await request(app)
        .post('/checkout/paypal/refund')
        .send({ paymentId: 'ORD', amount: 5, idempotencyKey: KEY });
      expect(response.status).toBe(200);
      expect(spy.mock.calls).toEqual([['paypal', 'ORD', 5]]);
      expect(paypalRefund.mock.calls).toEqual([['ORD', 5]]);
    });
  });
});

// Release review of 2.2.0 (#44): refund keys are the optional capability IRefundIdempotencyProvider, so that
// IPaymentProvider and BasePaymentProvider stay exactly 2.1 (the compile-time side is in `npm run typecheck`), and a
// key reaches a provider only through a refundPayment that can receive it.

/** Valid 2.1 code: an override with the 2.1 signature in a subclass of PayPalProvider (it inherits the flag). */
class LoggingPayPal extends PayPalProvider {
  async refundPayment(id: string, amount?: number): Promise<PaymentResult> {
    return super.refundPayment(id, amount);
  }
}

/** The same in a subclass of SatispayProvider. */
class LoggingSatispay extends SatispayProvider {
  async refundPayment(id: string, amount?: number): Promise<PaymentResult> {
    return super.refundPayment(id, amount);
  }
}

/** A 2.2 override that passes the options on, as README "Custom Provider" asks. */
class ForwardingPayPal extends PayPalProvider {
  async refundPayment(id: string, amount?: number, options?: RefundOptions): Promise<PaymentResult> {
    return super.refundPayment(id, amount, options);
  }
}

/** The documented opt-out. */
class OptOutPayPal extends PayPalProvider {
  readonly supportsRefundIdempotency = false;
}

/** Valid 2.1 code: an override with a third parameter of its own in a subclass of PayPalProvider. */
class ReasonPayPal extends PayPalProvider {
  async refundPayment(id: string, amount?: number, reason?: 'duplicate' | 'fraudulent'): Promise<PaymentResult> {
    return { ...(await super.refundPayment(id, amount)), raw: { reason } };
  }
}

describe('Refund idempotency capability: IRefundIdempotencyProvider (#44, release review)', () => {
  const originalFetch = globalThis.fetch;
  const credentials = { clientId: 'a', clientSecret: 'b' };
  let base: ReturnType<typeof vi.spyOn>;
  let events: any[];

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn() as any;
    // The library's own PayPal refund, reached through super.refundPayment: no SDK call
    base = vi.spyOn(PayPalProvider.prototype, 'refundPayment').mockResolvedValue({
      success: true,
      verified: true,
      paymentId: 'REFUND-1',
      status: 'COMPLETED',
    });
    events = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function configurator(provider: PayPalProvider | SatispayProvider): CheckoutConfigurator {
    const checkout = new CheckoutConfigurator();
    checkout.registerProvider(provider);
    checkout.events.on('payment.refunded', (payload) => {
      events.push(payload);
    });
    return checkout;
  }

  it('isRefundIdempotencyProvider is exported: PayPal and Satispay yes; Nexi and providers written for 2.1 no', () => {
    const guard = (index as Record<string, unknown>).isRefundIdempotencyProvider as (p: unknown) => boolean;
    expect(typeof guard).toBe('function');
    expect(guard(new PayPalProvider(credentials))).toBe(true);
    expect(guard(new SatispayProvider({ keyId: 'k', privateKey: 'unused' }))).toBe(true);
    expect(guard(new NexiProvider({ merchantId: 'ALIAS_TEST_01', macKey: 'TEST_SECRET_KEY_0001' }))).toBe(false);
    expect(guard(new DummyProvider())).toBe(false);
    expect(guard(new ReasonProvider())).toBe(false);
    for (const value of [null, undefined, 'paypal', 42]) expect(guard(value)).toBe(false);
  });

  it('isRefundIdempotencyProvider needs exactly supportsRefundIdempotency: true and a refundPayment that can take the options', () => {
    const guard = (index as Record<string, unknown>).isRefundIdempotencyProvider as (p: unknown) => boolean;
    const three = async (_id: string, _amount?: number, _options?: RefundOptions) => ({ success: true });
    expect(guard({ supportsRefundIdempotency: true, refundPayment: three })).toBe(true);
    // length 0: a rest parameter, or a wrapper that passes every argument on
    expect(guard({ supportsRefundIdempotency: true, refundPayment: async (..._args: unknown[]) => ({ success: true }) })).toBe(true);
    // One or two declared parameters cannot receive the options; a default value is not counted by length
    expect(guard({ supportsRefundIdempotency: true, refundPayment: async (_id: string) => ({ success: true }) })).toBe(false);
    expect(guard({ supportsRefundIdempotency: true, refundPayment: async (_id: string, _amount?: number) => ({ success: true }) })).toBe(false);
    expect(
      guard({ supportsRefundIdempotency: true, refundPayment: async (_id: string, _amount?: number, _o: RefundOptions = {}) => ({ success: true }) }),
    ).toBe(false);
    for (const flag of [false, 'true', 1, undefined]) {
      expect(guard({ supportsRefundIdempotency: flag, refundPayment: three })).toBe(false);
    }
    expect(guard({ supportsRefundIdempotency: true })).toBe(false);
  });

  it("a 2.1 override refundPayment(id, amount) in a PayPalProvider subclass: a key is refused, never dropped", async () => {
    const checkout = configurator(new LoggingPayPal(credentials));
    const err = await rejection(checkout.refundPayment('paypal', 'ORD-1', 5, { idempotencyKey: 'refund-SUB-1-R9' }));
    expect(err.code).toBe('REFUND_IDEMPOTENCY_NOT_SUPPORTED');
    expect(err.provider).toBe('paypal');
    expect(err.message).toBe(
      "Provider 'paypal' does not support refund idempotency keys: its refundPayment declares no options parameter",
    );
    expect(base).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('the same override still refunds without a key, with the 2.1 call', async () => {
    const checkout = configurator(new LoggingPayPal(credentials));
    const result = await checkout.refundPayment('paypal', 'ORD-1', 5);
    expect(base.mock.calls).toEqual([['ORD-1', 5]]);
    expect(result).toMatchObject({ success: true, verified: true, paymentId: 'REFUND-1' });
    expect(events).toHaveLength(1);
    // Options without a key are not a key: the 2.1 call too
    await checkout.refundPayment('paypal', 'ORD-1', 5, {});
    expect(base.mock.calls[1]).toEqual(['ORD-1', 5]);
  });

  it('a 2.1 override in a SatispayProvider subclass: a key is refused, and no request is sent', async () => {
    const checkout = configurator(new LoggingSatispay({ keyId: 'k', privateKey: 'unused' }));
    const err = await rejection(checkout.refundPayment('satispay', 'pay_1', 19.9, { idempotencyKey: 'refund-pay_1-R1' }));
    expect(err.code).toBe('REFUND_IDEMPOTENCY_NOT_SUPPORTED');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('an override that passes the options on gets the key, and so does the library refund behind it', async () => {
    const checkout = configurator(new ForwardingPayPal(credentials));
    const result = await checkout.refundPayment('paypal', 'ORD-1', 5, { idempotencyKey: 'refund-SUB-1-R9' });
    expect(base.mock.calls).toEqual([['ORD-1', 5, { idempotencyKey: 'refund-SUB-1-R9' }]]);
    expect(result.success).toBe(true);
  });

  it('a subclass that sets supportsRefundIdempotency = false: a key is refused', async () => {
    const checkout = configurator(new OptOutPayPal(credentials));
    const err = await rejection(checkout.refundPayment('paypal', 'ORD-1', 5, { idempotencyKey: 'refund-SUB-1-R9' }));
    expect(err.code).toBe('REFUND_IDEMPOTENCY_NOT_SUPPORTED');
    expect(err.message).toBe("Provider 'paypal' does not support refund idempotency keys");
    expect(base).not.toHaveBeenCalled();
  });

  it('a 2.1 override with a third parameter of its own: without a key, the 2.1 call; its own callers unchanged', async () => {
    const provider = new ReasonPayPal(credentials);
    const own = vi.spyOn(provider, 'refundPayment');
    const result = await configurator(provider).refundPayment('paypal', 'ORD-1', 5);
    expect(own.mock.calls).toEqual([['ORD-1', 5]]);
    expect(result.raw).toEqual({ reason: undefined });
    await expect(provider.refundPayment('ORD-2', 5, 'duplicate')).resolves.toMatchObject({ raw: { reason: 'duplicate' } });
  });
});
