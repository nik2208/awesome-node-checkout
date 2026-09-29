import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import * as crypto from 'crypto';
import { CheckoutConfigurator } from './checkout-configurator';
import { NexiProvider } from './providers/nexi/nexi.provider';
import { PayPalProvider } from './providers/paypal/paypal.provider';
import { SatispayProvider } from './providers/satispay/satispay.provider';
import { createCheckoutRouter } from './adapters/express';
import { CheckoutEventName, CheckoutEventPayload, CheckoutListenerError } from './events/checkout-event-bus';
import { IPaymentProvider } from './interfaces/payment-provider.interface';
import { ISO_4217_ALPHA3_CODES, parseIsoCurrency, parseNexiCurrency } from './utils/parsing.util';

const merchantId = 'TEST_MERCHANT_ID';
const macKey = 'TEST_MAC_KEY';
const ALL_EVENTS: CheckoutEventName[] = [
  'payment.created',
  'payment.completed',
  'payment.failed',
  'payment.refunded',
  'webhook.received',
];

function nexiOutcome(
  codTrans: string,
  esito = 'OK',
  importo = '1000',
  extra: Record<string, string> = {},
): Record<string, string> {
  const f = { codTrans, esito, importo, divisa: 'EUR', data: '20260928', orario: '120000', codAut: 'AUTH1' };
  const mac = crypto
    .createHash('sha1')
    .update(
      `codTrans=${f.codTrans}esito=${f.esito}importo=${f.importo}divisa=${f.divisa}` +
        `data=${f.data}orario=${f.orario}codAut=${f.codAut}${macKey}`,
    )
    .digest('hex');
  return { ...f, mac, ...extra };
}

function record(checkout: CheckoutConfigurator): Array<[CheckoutEventName, CheckoutEventPayload]> {
  const events: Array<[CheckoutEventName, CheckoutEventPayload]> = [];
  for (const e of ALL_EVENTS) checkout.events.on(e, (p) => { events.push([e, p]); });
  return events;
}

function mentions(value: unknown, needle: string): boolean {
  return JSON.stringify(value ?? null).includes(needle);
}

function buildApp(checkout: CheckoutConfigurator): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(
    '/checkout',
    createCheckoutRouter(checkout, {
      buildPaymentRequest: async () => ({
        amount: 10,
        currency: 'EUR',
        orderId: 'ORD1',
        returnUrl: 'https://r',
        cancelUrl: 'https://c',
      }),
    }),
  );
  return app;
}

/** A real NexiProvider exposed under a different registration name */
function nexiNamed(name: string): IPaymentProvider {
  return Object.assign(new NexiProvider({ merchantId, macKey }), { name }) as unknown as IPaymentProvider;
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  warnSpy.mockRestore();
});

describe('Issue #27 Acceptance Criteria Verification', () => {
  // ---------------------------------------------------------------------------
  // 1. Nexi execute: keyed on MAC-covered codTrans, mismatching paymentId rejected
  // ---------------------------------------------------------------------------
  describe('1. Nexi execute cross-order', () => {
    it('provider: paymentId argument different from codTrans -> failure, verified false', async () => {
      const nexi = new NexiProvider({ merchantId, macKey });
      const res = await nexi.executePayment('VICTIM', nexiOutcome('ATT', 'OK', '100'));
      expect(res).toEqual({
        success: false,
        verified: false,
        paymentId: undefined,
        status: 'FAILED',
        error: 'Payment id does not match the outcome',
      });
    });

    it('provider: matching paymentId -> keyed on codTrans, verified true', async () => {
      const nexi = new NexiProvider({ merchantId, macKey });
      const res = await nexi.executePayment('ATT', nexiOutcome('ATT', 'OK', '100'));
      expect(res.success).toBe(true);
      expect(res.verified).toBe(true);
      expect(res.paymentId).toBe('ATT');
      expect(res.orderId).toBe('ATT');
      expect(res.amount).toBe(1);
    });

    it.each([
      ['without a map entry for VICTIM', false],
      ['with a map entry for VICTIM', true],
    ])('configurator %s: no payment.completed, payment.failed without VICTIM', async (_label, withMap) => {
      const checkout = new CheckoutConfigurator().registerProvider(new NexiProvider({ merchantId, macKey }));
      if (withMap) (checkout as any).setPaymentOrder('VICTIM', 'VICTIM-ORDER');
      const events = record(checkout);

      const res = await checkout.executePayment('nexi', 'VICTIM', nexiOutcome('ATT', 'OK', '100'));

      expect(res.success).toBe(false);
      expect(res.verified).toBe(false);
      expect(res.error).toBe('Payment id does not match the outcome');
      expect(res.paymentId).toBeUndefined();
      expect(res.orderId).toBeUndefined();
      expect(events.map(([e]) => e)).toEqual(['payment.failed']);
      const [, payload] = events[0];
      expect(payload.verified).toBe(false);
      expect(payload.paymentId).toBeUndefined();
      expect(payload.orderId).toBeUndefined();
      expect(mentions({ ...payload, raw: undefined }, 'VICTIM')).toBe(false);
    });

    it('configurator: no paymentId argument -> keyed on codTrans (and the local map)', async () => {
      const checkout = new CheckoutConfigurator().registerProvider(new NexiProvider({ merchantId, macKey }));
      (checkout as any).setPaymentOrder('ATT', 'ORDER-OF-ATT');
      const events = record(checkout);

      const res = await checkout.executePayment('nexi', '', nexiOutcome('ATT', 'OK', '100'));

      expect(res.success).toBe(true);
      expect(res.paymentId).toBe('ATT');
      expect(res.orderId).toBe('ORDER-OF-ATT');
      expect(events).toHaveLength(1);
      expect(events[0][0]).toBe('payment.completed');
      expect(events[0][1]).toMatchObject({ paymentId: 'ATT', orderId: 'ORDER-OF-ATT', verified: true });
    });

    it('HTTP POST /nexi/execute with paymentId VICTIM and ATT outcome -> 400, no payment.completed', async () => {
      for (const withMap of [false, true]) {
        const checkout = new CheckoutConfigurator().registerProvider(new NexiProvider({ merchantId, macKey }));
        if (withMap) (checkout as any).setPaymentOrder('VICTIM', 'VICTIM');
        const events = record(checkout);

        const res = await request(buildApp(checkout))
          .post('/checkout/nexi/execute')
          .send({ paymentId: 'VICTIM', data: nexiOutcome('ATT', 'OK', '100') });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.verified).toBe(false);
        expect(res.body.error).toBe('Payment id does not match the outcome');
        expect(mentions(res.body, 'VICTIM')).toBe(false);
        expect(res.body.paymentId).toBeUndefined();
        expect(events.map(([e]) => e)).toEqual(['payment.failed']);
        expect(events[0][1].verified).toBe(false);
        expect(events[0][1].orderId).toBeUndefined();
        expect(events[0][1].paymentId).toBeUndefined();
      }
    });

    it('generic providers: a verified outcome for another id is rejected by the configurator too', async () => {
      const custom: IPaymentProvider = {
        name: 'custom',
        flow: 'direct',
        createPayment: async () => ({ success: true }),
        executePayment: async () => ({ success: true, verified: true, paymentId: 'OTHER', status: 'COMPLETED' }),
        getPaymentDetails: async () => ({ success: true }),
        refundPayment: async () => ({ success: true }),
      };
      const checkout = new CheckoutConfigurator().registerProvider(custom);
      const events = record(checkout);
      const res = await checkout.executePayment('custom', 'VICTIM');
      expect(res.success).toBe(false);
      expect(res.error).toBe('Payment id does not match the outcome');
      expect(events.map(([e]) => e)).toEqual(['payment.failed']);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. No orderId from query / unsigned fields, for any provider and any name
  // ---------------------------------------------------------------------------
  describe('2. orderId never taken from the query of a redirect or an unsigned callback', () => {
    function paypalWithCapture(): PayPalProvider {
      const paypal = new PayPalProvider({ clientId: 'a', clientSecret: 'b' });
      (paypal as any).ordersController = {
        captureOrder: vi.fn().mockResolvedValue({
          result: {
            id: 'PPORD',
            status: 'COMPLETED',
            purchaseUnits: [
              { payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { value: '1.00', currencyCode: 'EUR' } }] } },
            ],
          },
        }),
      };
      return paypal;
    }

    it('PayPal redirect (fresh configurator) ignores query order_id', async () => {
      const checkout = new CheckoutConfigurator().registerProvider(paypalWithCapture());
      const events = record(checkout);

      const res = await checkout.handleRedirect('paypal', { token: 'PPORD', PayerID: 'X', order_id: 'VICTIM' });

      expect(res.success).toBe(true);
      expect(res.verified).toBe(true);
      expect(res.paymentId).toBe('PPORD');
      expect(res.orderId).toBeUndefined();
      expect(events).toHaveLength(1);
      expect(events[0][0]).toBe('payment.completed');
      expect(events[0][1].orderId).toBeUndefined();
      expect(events[0][1].verified).toBe(true);
    });

    it('PayPal redirect over HTTP ignores query order_id; the local map still applies', async () => {
      const checkout = new CheckoutConfigurator().registerProvider(paypalWithCapture());
      let res = await request(buildApp(checkout)).get('/checkout/paypal/redirect?token=PPORD&PayerID=X&order_id=VICTIM');
      expect(res.status).toBe(200);
      expect(res.body.orderId).toBeUndefined();
      expect(mentions(res.body, 'VICTIM')).toBe(false);

      (checkout as any).setPaymentOrder('PPORD', 'MY-ORDER');
      res = await request(buildApp(checkout)).get('/checkout/paypal/redirect?token=PPORD&PayerID=X&order_id=VICTIM');
      expect(res.body.orderId).toBe('MY-ORDER');
    });

    describe('Satispay without webhookPublicKey', () => {
      const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const payment = (o: Record<string, unknown> = {}) => ({
        id: 'pay_1',
        status: 'ACCEPTED',
        amount_unit: 1000,
        currency: 'EUR',
        ...o,
      });

      it('unsigned POST ?order_id=VICTIM + body orderId/order_id, API without external_code -> no orderId', async () => {
        const satispay = new SatispayProvider({ keyId: 'k', privateKey });
        (satispay as any).request = vi.fn().mockResolvedValue(payment());
        const checkout = new CheckoutConfigurator().registerProvider(satispay);
        const events = record(checkout);

        const res = await request(buildApp(checkout))
          .post('/checkout/satispay/webhook?order_id=VICTIM')
          .send({ payment_id: 'pay_1', orderId: 'VICTIM2', order_id: 'VICTIM3' });

        expect(res.status).toBe(200);
        expect(res.body.verified).toBe(true);
        expect(res.body.orderId).toBeUndefined();
        expect(mentions(res.body, 'VICTIM')).toBe(false);
        expect(events[0][0]).toBe('webhook.received');
        expect(events[0][1].orderId).toBeUndefined();
      });

      it('external_code from the authenticated API read is still used', async () => {
        const satispay = new SatispayProvider({ keyId: 'k', privateKey });
        (satispay as any).request = vi.fn().mockResolvedValue(payment({ external_code: 'ORD1' }));
        const checkout = new CheckoutConfigurator().registerProvider(satispay);

        const res = await checkout.handleWebhook('satispay', { payment_id: 'pay_1' }, {}, { order_id: 'VICTIM' }, { method: 'POST' });
        expect(res.orderId).toBe('ORD1');
      });

      it('redirect returns the orderId from the store/API, not from the query', async () => {
        const satispay = new SatispayProvider({ keyId: 'k', privateKey });
        (satispay as any).request = vi.fn().mockResolvedValue(payment());
        await (satispay as any).transactionStore.save('ORD1', {
          provider: 'satispay',
          orderId: 'ORD1',
          paymentId: 'pay_1',
          createdAt: new Date().toISOString(),
        });
        const checkout = new CheckoutConfigurator().registerProvider(satispay);
        const events = record(checkout);

        const res = await checkout.handleRedirect('satispay', { order_id: 'ORD1' });
        expect(res.success).toBe(true);
        expect(res.verified).toBe(true);
        expect(res.orderId).toBe('ORD1');
        expect(events[0][1]).toMatchObject({ orderId: 'ORD1', paymentId: 'pay_1', verified: true });
      });

      it('API read failure -> verified false, no paymentId/orderId from the request', async () => {
        const satispay = new SatispayProvider({ keyId: 'k', privateKey });
        (satispay as any).request = vi.fn().mockRejectedValue(new Error('Satispay API returned HTTP 500'));
        const checkout = new CheckoutConfigurator().registerProvider(satispay);
        const events = record(checkout);

        const res = await checkout.handleWebhook('satispay', { payment_id: 'pay_1' }, {}, { order_id: 'VICTIM' }, { method: 'POST' });
        expect(res.success).toBe(false);
        expect(res.verified).toBe(false);
        expect(res.paymentId).toBeUndefined();
        expect(res.orderId).toBeUndefined();
        expect(events[0][1]).toMatchObject({ verified: false, paymentId: undefined, orderId: undefined });
      });
    });

    describe('NexiProvider registered as nexi-prod', () => {
      it('redirect with valid MAC: orderId is codTrans, never query order_id', async () => {
        const checkout = new CheckoutConfigurator().registerProvider(nexiNamed('nexi-prod'));
        const events = record(checkout);

        const res = await checkout.handleRedirect(
          'nexi-prod',
          nexiOutcome('GENUINE', 'OK', '1000', { order_id: 'VICTIM', orderId: 'VICTIM', external_code: 'VICTIM' }),
        );

        expect(res.success).toBe(true);
        expect(res.orderId).toBe('GENUINE');
        expect(events[0][0]).toBe('payment.completed');
        expect(events[0][1].orderId).toBe('GENUINE');
      });

      it('redirect over HTTP: JSON body orderId is codTrans', async () => {
        const checkout = new CheckoutConfigurator().registerProvider(nexiNamed('nexi-prod'));
        const res = await request(buildApp(checkout)).get(
          '/checkout/nexi-prod/redirect?' + new URLSearchParams(nexiOutcome('GENUINE', 'OK', '1000', { order_id: 'VICTIM' })),
        );
        expect(res.status).toBe(200);
        expect(res.body.orderId).toBe('GENUINE');
        expect(mentions(res.body, 'VICTIM')).toBe(false);
      });

      it('webhook with valid MAC: body external_code/orderId/order_id and query order_id ignored', async () => {
        const checkout = new CheckoutConfigurator().registerProvider(nexiNamed('nexi-prod'));
        const events = record(checkout);

        const res = await checkout.handleWebhook(
          'nexi-prod',
          nexiOutcome('GENUINE', 'OK', '1000', { orderId: 'VICTIM', order_id: 'VICTIM', external_code: 'VICTIM' }),
          {},
          { order_id: 'VICTIM' },
          { method: 'POST' },
        );

        expect(res.verified).toBe(true);
        expect(res.orderId).toBe('GENUINE');
        expect(events[0][1].orderId).toBe('GENUINE');
      });

      it('webhook with bad MAC: no orderId from body or query', async () => {
        const checkout = new CheckoutConfigurator().registerProvider(nexiNamed('nexi-prod'));
        const res = await checkout.handleWebhook(
          'nexi-prod',
          { ...nexiOutcome('GENUINE'), mac: 'a'.repeat(40), external_code: 'VICTIM', orderId: 'VICTIM' },
          {},
          { order_id: 'VICTIM' },
          { method: 'POST' },
        );
        expect(res.verified).toBe(false);
        expect(res.orderId).toBeUndefined();
        expect(res.paymentId).toBeUndefined();
      });
    });

    it('custom provider that does not set verified: fail closed (no success, no ids)', async () => {
      const custom: IPaymentProvider = {
        name: 'custom',
        flow: 'redirect',
        createPayment: async () => ({ success: true }),
        executePayment: async () => ({ success: true }),
        getPaymentDetails: async () => ({ success: true }),
        refundPayment: async () => ({ success: true }),
        handleRedirect: async (q) => ({ success: true, paymentId: q.id, status: 'COMPLETED' }),
      };
      const checkout = new CheckoutConfigurator().registerProvider(custom);
      const events = record(checkout);
      const res = await checkout.handleRedirect('custom', { id: 'P1', order_id: 'VICTIM' });
      expect(res.success).toBe(false);
      expect(res.verified).toBe(false);
      expect(res.error).toBe('Payment outcome could not be verified');
      expect(res.paymentId).toBeUndefined();
      expect(res.orderId).toBeUndefined();
      expect(events.map(([e]) => e)).toEqual(['payment.failed']);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. verified matrix per event
  // ---------------------------------------------------------------------------
  describe('3. verified has one meaning across events', () => {
    const newNexi = () => {
      const checkout = new CheckoutConfigurator().registerProvider(new NexiProvider({ merchantId, macKey }));
      return { checkout, events: record(checkout) };
    };

    it('payment.created -> verified false (no outcome yet)', async () => {
      const { checkout, events } = newNexi();
      await checkout.createPayment('nexi', { amount: 10, currency: 'EUR', orderId: 'O1', returnUrl: 'https://r', cancelUrl: 'https://c' });
      expect(events[0][0]).toBe('payment.created');
      expect(events[0][1].verified).toBe(false);
      expect(events[0][1].paymentId).toBe('O1');
    });

    it('redirect OK with valid MAC -> payment.completed verified true', async () => {
      const { checkout, events } = newNexi();
      await checkout.handleRedirect('nexi', nexiOutcome('O1'));
      expect(events[0]).toEqual(['payment.completed', expect.objectContaining({ verified: true, paymentId: 'O1', orderId: 'O1' })]);
    });

    it('redirect KO with valid MAC -> payment.failed verified true + error (like the webhook)', async () => {
      const { checkout, events } = newNexi();
      const res = await checkout.handleRedirect('nexi', nexiOutcome('O1', 'KO'));
      expect(res).toMatchObject({ success: false, verified: true, error: 'Payment failed with outcome KO' });
      expect(events[0]).toEqual([
        'payment.failed',
        expect.objectContaining({ verified: true, paymentId: 'O1', orderId: 'O1', error: 'Payment failed with outcome KO' }),
      ]);
    });

    it('execute KO with valid MAC -> payment.failed verified true + error', async () => {
      const { checkout, events } = newNexi();
      await checkout.executePayment('nexi', 'O1', nexiOutcome('O1', 'KO'));
      expect(events[0]).toEqual(['payment.failed', expect.objectContaining({ verified: true, error: 'Payment failed with outcome KO' })]);
    });

    it('redirect with bad MAC -> payment.failed verified false, no ids', async () => {
      const { checkout, events } = newNexi();
      await checkout.handleRedirect('nexi', { ...nexiOutcome('O1'), mac: 'b'.repeat(40), order_id: 'VICTIM' });
      expect(events[0]).toEqual([
        'payment.failed',
        expect.objectContaining({ verified: false, paymentId: undefined, orderId: undefined }),
      ]);
    });

    it('webhook KO with valid MAC -> webhook.received verified true + error', async () => {
      const { checkout, events } = newNexi();
      await checkout.handleWebhook('nexi', nexiOutcome('O1', 'KO'), {}, {}, { method: 'POST' });
      expect(events[0]).toEqual([
        'webhook.received',
        expect.objectContaining({ verified: true, error: 'Payment failed with outcome KO' }),
      ]);
    });

    it('payment.refunded: verified true for an API response (PayPal), false when not authenticated (Nexi)', async () => {
      const paypal = new PayPalProvider({ clientId: 'a', clientSecret: 'b' });
      (paypal as any).ordersController = {
        getOrder: vi.fn().mockResolvedValue({
          result: { id: 'PPORD', purchaseUnits: [{ amount: { currencyCode: 'EUR' }, payments: { captures: [{ id: 'CAP1' }] } }] },
        }),
      };
      (paypal as any).paymentsController = {
        refundCapturedPayment: vi.fn().mockResolvedValue({ result: { id: 'REF1', status: 'COMPLETED' } }),
      };
      const checkout = new CheckoutConfigurator().registerProvider(paypal).registerProvider(new NexiProvider({ merchantId, macKey }));
      const events = record(checkout);
      await checkout.refundPayment('paypal', 'PPORD');
      expect(events[0]).toEqual(['payment.refunded', expect.objectContaining({ verified: true })]);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ esito: 'OK' }), { status: 200 })) as any;
      try {
        await checkout.refundPayment('nexi', 'O1');
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(events[1]).toEqual(['payment.refunded', expect.objectContaining({ verified: false })]);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Listener errors are wrapped, never mutated
  // ---------------------------------------------------------------------------
  describe('4. Frozen listener errors are preserved', () => {
    it('event bus wraps the error in CheckoutListenerError with cause, without mutating it', async () => {
      const checkout = new CheckoutConfigurator().registerProvider(new NexiProvider({ merchantId, macKey }));
      const frozen = Object.freeze(new Error('frozen JSON'));
      checkout.events.on('payment.created', () => { throw frozen; });

      let caught: unknown;
      try {
        await checkout.createPayment('nexi', { amount: 10, currency: 'EUR', orderId: 'O1', returnUrl: 'https://r', cancelUrl: 'https://c' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CheckoutListenerError);
      expect((caught as CheckoutListenerError).message).toBe('frozen JSON');
      expect((caught as CheckoutListenerError).cause).toBe(frozen);
      expect((caught as CheckoutListenerError).event).toBe('payment.created');
      expect(Object.keys(frozen)).toEqual([]);
    });

    it('non-Error values are wrapped with String(value) as message', async () => {
      const checkout = new CheckoutConfigurator().registerProvider(new NexiProvider({ merchantId, macKey }));
      checkout.events.on('payment.created', () => { throw 'JSON str'; });
      await expect(
        checkout.createPayment('nexi', { amount: 10, currency: 'EUR', orderId: 'O1', returnUrl: 'https://r', cancelUrl: 'https://c' }),
      ).rejects.toMatchObject({ name: 'CheckoutListenerError', message: 'JSON str', cause: 'JSON str' });
    });

    it.each([
      ['payment.completed (redirect)', 'payment.completed' as CheckoutEventName, 'redirect'],
      ['webhook.received', 'webhook.received' as CheckoutEventName, 'webhook'],
      ['payment.created', 'payment.created' as CheckoutEventName, 'create'],
    ])('HTTP %s: a frozen Error("frozen JSON") keeps its message', async (_label, event, route) => {
      const checkout = new CheckoutConfigurator().registerProvider(new NexiProvider({ merchantId, macKey }));
      checkout.events.on(event, () => { throw Object.freeze(new Error('frozen JSON')); });
      const app = buildApp(checkout);
      const res =
        route === 'redirect'
          ? await request(app).get('/checkout/nexi/redirect?' + new URLSearchParams(nexiOutcome('O1')))
          : route === 'webhook'
          ? await request(app).post('/checkout/nexi/webhook').type('form').send(nexiOutcome('O1'))
          : await request(app).post('/checkout/nexi').send({});
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, error: 'frozen JSON' });
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Real ISO 4217 list
  // ---------------------------------------------------------------------------
  describe('5. ISO 4217 currency list', () => {
    it.each(['EUR', 'eur', ' EUR ', 'USD', 'GBP', 'CHF', 'JPY', 978, '978'])('accepts %j', (code) => {
      expect(parseIsoCurrency(code)).toMatch(/^[A-Z]{3}$/);
    });

    it.each(['XYZ', 'ABC', 'EURO', 'EU', '', 999, 'XXX', 'XTS', 'XAU'])('rejects %j', (code) => {
      expect(parseIsoCurrency(code)).toBeUndefined();
      expect(parseNexiCurrency(code)).toBeUndefined();
    });

    it('list contains the active codes and not shape-only ones', () => {
      expect(ISO_4217_ALPHA3_CODES.size).toBeGreaterThanOrEqual(150);
      for (const c of ['EUR', 'USD', 'GBP', 'CHF', 'JPY', 'SEK', 'PLN', 'CZK', 'HUF', 'RON', 'XCG', 'ZWG', 'SLE', 'VED']) {
        expect(ISO_4217_ALPHA3_CODES.has(c)).toBe(true);
      }
      for (const c of ['XYZ', 'ABC', 'AAA', 'ZZZ', 'EUX']) {
        expect(ISO_4217_ALPHA3_CODES.has(c)).toBe(false);
      }
    });

    it('Satispay rejects XYZ/ABC in createPayment and in the API outcome', async () => {
      const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const satispay = new SatispayProvider({ keyId: 'k', privateKey });
      const req = vi.fn();
      (satispay as any).request = req;
      for (const cur of ['XYZ', 'ABC']) {
        const created = await satispay.createPayment({ amount: 10, currency: cur, returnUrl: 'https://r', cancelUrl: 'https://c' });
        expect(created).toMatchObject({ success: false, error: 'Payment currency is missing or invalid' });
      }
      expect(req).not.toHaveBeenCalled();

      req.mockResolvedValue({ id: 'pay_1', status: 'ACCEPTED', amount_unit: 1000, currency: 'XYZ' });
      const details = await satispay.getPaymentDetails('pay_1');
      expect(details).toMatchObject({ success: false, error: 'Payment currency is missing or invalid' });
      const hook = await satispay.handleWebhook(undefined, {}, { payment_id: 'pay_1' }, { method: 'GET' });
      expect(hook).toMatchObject({ success: false, error: 'Payment currency is missing or invalid' });
    });
  });
});
