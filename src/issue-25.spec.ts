import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import * as crypto from 'crypto';
import { CheckoutConfigurator } from './checkout-configurator';
import { NexiProvider } from './providers/nexi/nexi.provider';
import { SatispayProvider } from './providers/satispay/satispay.provider';
import { createCheckoutRouter } from './adapters/express';
import { WebhookResult } from './models/payment-result.model';
import { CheckoutEventPayload } from './events/checkout-event-bus';

describe('Issue #25 Acceptance Criteria Verification', () => {
  const merchantId = 'TEST_MERCHANT_ID';
  const macKey = 'TEST_MAC_KEY';

  function generateValidNexiRedirectQuery(
    codTrans: string,
    esito: string = 'OK',
    importo: string = '1000',
    divisa: string = 'EUR',
    extraQuery: Record<string, string> = {},
  ): Record<string, string> {
    const data = '20260928';
    const orario = '120000';
    const codAut = 'AUTH123';
    // Mac formula: codTrans=...esito=...importo=...divisa=...data=...orario=...codAut=...{macKey}
    const macString = `codTrans=${codTrans}esito=${esito}importo=${importo}divisa=${divisa}data=${data}orario=${orario}codAut=${codAut}${macKey}`;
    const mac = crypto.createHash('sha1').update(macString).digest('hex');

    return {
      codTrans,
      esito,
      importo,
      divisa,
      data,
      orario,
      codAut,
      mac,
      ...extraQuery,
    };
  }

  // ---------------------------------------------------------------------------
  // 1. Nexi redirect: unsigned order_id never reaches result, events or onSuccess
  // ---------------------------------------------------------------------------
  describe('1. Nexi redirect unsigned order_id injection prevention', () => {
    it('with valid MAC and NO local map: orderId comes strictly from codTrans, ignoring query.order_id', async () => {
      const checkout = new CheckoutConfigurator();
      const nexi = new NexiProvider({ merchantId, macKey });
      checkout.registerProvider(nexi);

      let capturedCompletedEvent: CheckoutEventPayload | undefined;
      checkout.events.on('payment.completed', (payload) => {
        capturedCompletedEvent = payload;
      });

      const query = generateValidNexiRedirectQuery('GENUINE_COD_TRANS', 'OK', '1000', 'EUR', {
        order_id: 'VICTIM',
      });

      const result = await checkout.handleRedirect('nexi', query);

      expect(result.success).toBe(true);
      expect(result.paymentId).toBe('GENUINE_COD_TRANS');
      expect(result.orderId).toBe('GENUINE_COD_TRANS');
      expect(result.orderId).not.toBe('VICTIM');

      expect(capturedCompletedEvent).toBeDefined();
      expect(capturedCompletedEvent?.orderId).toBe('GENUINE_COD_TRANS');
      expect(capturedCompletedEvent?.orderId).not.toBe('VICTIM');
      expect(capturedCompletedEvent?.verified).toBe(true);
    });

    it('with valid MAC and local map: orderId comes from local map, ignoring query.order_id', async () => {
      const checkout = new CheckoutConfigurator();
      const nexi = new NexiProvider({ merchantId, macKey });
      checkout.registerProvider(nexi);

      // Simulate createPayment having populated the local paymentOrders map
      (checkout as any).setPaymentOrder('COD_MAP_123', 'MAPPED_ORDER_ID');

      let capturedCompletedEvent: CheckoutEventPayload | undefined;
      checkout.events.on('payment.completed', (payload) => {
        capturedCompletedEvent = payload;
      });

      const query = generateValidNexiRedirectQuery('COD_MAP_123', 'OK', '1000', 'EUR', {
        order_id: 'VICTIM',
      });

      const result = await checkout.handleRedirect('nexi', query);

      expect(result.success).toBe(true);
      expect(result.paymentId).toBe('COD_MAP_123');
      expect(result.orderId).toBe('MAPPED_ORDER_ID');
      expect(result.orderId).not.toBe('VICTIM');

      expect(capturedCompletedEvent?.orderId).toBe('MAPPED_ORDER_ID');
      expect(capturedCompletedEvent?.verified).toBe(true);
    });

    it('with invalid / bad MAC: orderId and paymentId are undefined and do not leak query.order_id', async () => {
      const checkout = new CheckoutConfigurator();
      const nexi = new NexiProvider({ merchantId, macKey });
      checkout.registerProvider(nexi);

      let capturedFailedEvent: CheckoutEventPayload | undefined;
      checkout.events.on('payment.failed', (payload) => {
        capturedFailedEvent = payload;
      });

      const query = {
        codTrans: 'SUSPICIOUS_COD',
        esito: 'OK',
        importo: '1000',
        divisa: 'EUR',
        data: '20260928',
        orario: '120000',
        codAut: 'AUTH123',
        mac: 'deadbeef00000000000000000000000000000000', // Invalid MAC
        order_id: 'VICTIM',
      };

      const result = await checkout.handleRedirect('nexi', query);

      expect(result.success).toBe(false);
      expect(result.paymentId).toBeUndefined();
      expect(result.orderId).toBeUndefined();

      expect(capturedFailedEvent).toBeDefined();
      expect(capturedFailedEvent?.orderId).toBeUndefined();
      expect(capturedFailedEvent?.paymentId).toBeUndefined();
      expect(capturedFailedEvent?.verified).toBe(false);
    });

    it('Express Adapter GET /:provider/redirect: options.redirect.onSuccess receives sanitized orderId', async () => {
      const checkout = new CheckoutConfigurator();
      const nexi = new NexiProvider({ merchantId, macKey });
      checkout.registerProvider(nexi);

      let onSuccessOrderId: string | undefined;
      const app = express();
      app.use(
        '/checkout',
        createCheckoutRouter(checkout, {
          redirect: {
            onSuccess: (res) => {
              onSuccessOrderId = res.orderId;
              return `/success?order=${res.orderId}`;
            },
            onFailure: (res) => `/fail?err=${res.error}`,
          },
        }),
      );

      const query = generateValidNexiRedirectQuery('COD_EXPRESS_1', 'OK', '1000', 'EUR', {
        order_id: 'VICTIM',
      });

      const response = await request(app).get('/checkout/nexi/redirect').query(query);

      expect(response.status).toBe(302);
      expect(response.headers['location']).toBe('/success?order=COD_EXPRESS_1');
      expect(onSuccessOrderId).toBe('COD_EXPRESS_1');
      expect(onSuccessOrderId).not.toBe('VICTIM');
    });

    it('Express Adapter GET /:provider/redirect without redirect options: JSON body has sanitized orderId', async () => {
      const checkout = new CheckoutConfigurator();
      const nexi = new NexiProvider({ merchantId, macKey });
      checkout.registerProvider(nexi);

      const app = express();
      app.use('/checkout', createCheckoutRouter(checkout));

      const query = generateValidNexiRedirectQuery('COD_EXPRESS_2', 'OK', '1000', 'EUR', {
        order_id: 'VICTIM',
      });

      const response = await request(app).get('/checkout/nexi/redirect').query(query);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.orderId).toBe('COD_EXPRESS_2');
      expect(response.body.orderId).not.toBe('VICTIM');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Consumer event listener errors not masked
  // ---------------------------------------------------------------------------
  describe('2. Consumer event listener errors are not masked as Invalid provider response', () => {
    it('Express Adapter does NOT mask consumer event listener throwing string with JSON', async () => {
      const checkout = new CheckoutConfigurator();
      const nexi = new NexiProvider({ merchantId, macKey });
      checkout.registerProvider(nexi);

      checkout.events.on('payment.created', () => {
        throw 'listener JSON boom';
      });

      const app = express();
      app.use(express.json());
      app.use(
        '/checkout',
        createCheckoutRouter(checkout, {
          buildPaymentRequest: () => ({
            amount: 50,
            currency: 'EUR',
            orderId: 'ORD-1',
            returnUrl: 'https://ex.com/ret',
            cancelUrl: 'https://ex.com/can',
          }),
        }),
      );

      const res = await request(app)
        .post('/checkout/nexi')
        .send({ amount: 50, currency: 'EUR' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('listener JSON boom');
      expect(res.body.error).not.toBe('Invalid provider response');
    });

    it('Express Adapter does NOT mask consumer event listener throwing Error with JSON in message', async () => {
      const checkout = new CheckoutConfigurator();
      const nexi = new NexiProvider({ merchantId, macKey });
      checkout.registerProvider(nexi);

      checkout.events.on('payment.created', () => {
        throw new Error('Custom consumer JSON processing error');
      });

      const app = express();
      app.use(express.json());
      app.use(
        '/checkout',
        createCheckoutRouter(checkout, {
          buildPaymentRequest: () => ({
            amount: 50,
            currency: 'EUR',
            orderId: 'ORD-1',
            returnUrl: 'https://ex.com/ret',
            cancelUrl: 'https://ex.com/can',
          }),
        }),
      );

      const res = await request(app)
        .post('/checkout/nexi')
        .send({ amount: 50, currency: 'EUR' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Custom consumer JSON processing error');
      expect(res.body.error).not.toBe('Invalid provider response');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Failed Nexi MAC: paymentId is absent
  // ---------------------------------------------------------------------------
  describe('3. Failed Nexi MAC: paymentId is absent', () => {
    it('handleWebhook omits paymentId when MAC verification fails', async () => {
      const nexi = new NexiProvider({ merchantId, macKey });
      const badWebhookBody = {
        codTrans: 'UNVERIFIED_TRANS',
        esito: 'OK',
        importo: '1000',
        divisa: 'EUR',
        data: '20260928',
        orario: '120000',
        codAut: 'AUTH123',
        mac: '0000000000000000000000000000000000000000',
      };

      const result = await nexi.handleWebhook(badWebhookBody);

      expect(result.success).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.paymentId).toBeUndefined();
    });

    it('executePayment omits paymentId when MAC verification fails', async () => {
      const nexi = new NexiProvider({ merchantId, macKey });
      const badQuery = {
        codTrans: 'UNVERIFIED_TRANS',
        esito: 'OK',
        importo: '1000',
        divisa: 'EUR',
        data: '20260928',
        orario: '120000',
        codAut: 'AUTH123',
        mac: '0000000000000000000000000000000000000000',
      };

      const result = await nexi.executePayment('UNVERIFIED_TRANS', badQuery);

      expect(result.success).toBe(false);
      expect(result.paymentId).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Satispay currency validation & verified semantics
  // ---------------------------------------------------------------------------
  describe('4. Satispay currency validation & verified semantics', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    it('createPayment rejects non-ISO currency strings like "EURO"', async () => {
      const satispay = new SatispayProvider({ keyId: 'k1', privateKey });

      const res = await satispay.createPayment({
        amount: 10,
        currency: 'EURO',
        returnUrl: 'https://ex.com/ret',
        cancelUrl: 'https://ex.com/can',
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe('Payment currency is missing or invalid');
    });

    it('getPaymentDetails rejects non-ISO currency strings like "EURO" returned by upstream', async () => {
      const satispay = new SatispayProvider({ keyId: 'k1', privateKey });

      // Mock request returning 'EURO' currency
      (satispay as any).request = vi.fn().mockResolvedValue({
        id: 'pay-123',
        status: 'ACCEPTED',
        amount_unit: 1000,
        currency: 'EURO',
      });

      const res = await satispay.getPaymentDetails('pay-123');

      expect(res.success).toBe(false);
      expect(res.error).toBe('Payment currency is missing or invalid');
    });

    it('handleWebhook rejects non-ISO currency strings like "EURO" returned by upstream', async () => {
      const satispay = new SatispayProvider({ keyId: 'k1', privateKey });

      (satispay as any).request = vi.fn().mockResolvedValue({
        id: 'pay-456',
        status: 'ACCEPTED',
        amount_unit: 1000,
        currency: 'EURO',
      });

      const res = await satispay.handleWebhook(
        { payment_id: 'pay-456' },
        {},
        {},
        { method: 'POST' },
      );

      expect(res.success).toBe(false);
      expect(res.error).toBe('Payment currency is missing or invalid');
    });

    it('handleWebhook accepts valid ISO-4217 numeric (978) and alpha (EUR) currencies', async () => {
      const satispay = new SatispayProvider({ keyId: 'k1', privateKey });

      (satispay as any).request = vi.fn().mockResolvedValue({
        id: 'pay-789',
        status: 'ACCEPTED',
        amount_unit: 1000,
        currency: '978',
      });

      const res = await satispay.handleWebhook(
        { payment_id: 'pay-789' },
        {},
        {},
        { method: 'POST' },
      );

      expect(res.success).toBe(true);
      expect(res.verified).toBe(true);
      expect(res.currency).toBe('EUR');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Types check: verified: boolean is required
  // ---------------------------------------------------------------------------
  describe('5. verified: boolean required on WebhookResult and events', () => {
    it('verifies that WebhookResult.verified is boolean', () => {
      const sample: WebhookResult = {
        success: true,
        verified: true,
        status: 'COMPLETED',
      };
      expect(typeof sample.verified).toBe('boolean');
    });

    it('verifies that CheckoutEventPayload.verified is boolean on every event', async () => {
      const checkout = new CheckoutConfigurator();
      const nexi = new NexiProvider({ merchantId, macKey });
      checkout.registerProvider(nexi);

      let eventVerified: boolean | undefined;
      checkout.events.on('payment.created', (e) => {
        eventVerified = e.verified;
      });

      await checkout.createPayment('nexi', {
        amount: 25,
        currency: 'EUR',
        orderId: 'ORD-TYP-1',
        returnUrl: 'https://ex.com/ret',
        cancelUrl: 'https://ex.com/can',
      });

      expect(typeof eventVerified).toBe('boolean');
    });
  });
});
