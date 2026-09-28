import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { CheckoutConfigurator } from './checkout-configurator';
import { NexiProvider } from './providers/nexi/nexi.provider';
import { SatispayProvider } from './providers/satispay/satispay.provider';
import { createCheckoutRouter } from './adapters/express';

describe('Issue #23 Acceptance Criteria Verification', () => {
  const nexiApiKey = 'TEST_MERCHANT_KEY';
  const nexiMacKey = 'TEST_MAC_KEY_1234567890_SECRET';

  function generateNexiOutcomeMac(
    codTrans: string,
    esito: string,
    importo: string,
    divisa: string,
    data: string,
    orario: string,
    codAut: string,
  ): string {
    const raw = `codTrans=${codTrans}esito=${esito}importo=${importo}divisa=${divisa}data=${data}orario=${orario}codAut=${codAut}${nexiMacKey}`;
    return crypto.createHash('sha1').update(raw).digest('hex');
  }

  describe('1. Nexi webhook: extra orderId in body never reaches result or event', () => {
    it('should ignore unsigned orderId and order_id in body and use codTrans/local map with valid MAC', async () => {
      const configurator = new CheckoutConfigurator();
      const nexi = new NexiProvider({
        merchantId: nexiApiKey,
        macKey: nexiMacKey,
        environment: 'sandbox',
      });
      configurator.registerProvider(nexi);

      const spyEmit = vi.spyOn(configurator.events, 'emit');

      const codTrans = 'ORD-REAL-123';
      const esito = 'OK';
      const importo = '5000'; // 50.00 EUR
      const divisa = 'EUR';
      const dataStr = '20260928';
      const orario = '210000';
      const codAut = 'AUTH123';
      const mac = generateNexiOutcomeMac(codTrans, esito, importo, divisa, dataStr, orario, codAut);

      const bodyWithAttackerField = {
        codTrans,
        esito,
        importo,
        divisa,
        data: dataStr,
        orario,
        codAut,
        mac,
        orderId: 'VICTIM-ORDER-999',
        order_id: 'VICTIM-ORDER-888',
      };

      const result = await configurator.handleWebhook('nexi', bodyWithAttackerField);

      expect(result.success).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.paymentId).toBe(codTrans);
      expect(result.orderId).toBe(codTrans);
      expect(result.orderId).not.toBe('VICTIM-ORDER-999');
      expect(result.orderId).not.toBe('VICTIM-ORDER-888');

      expect(spyEmit).toHaveBeenCalledWith('webhook.received', expect.objectContaining({
        provider: 'nexi',
        paymentId: codTrans,
        orderId: codTrans,
        verified: true,
        status: 'COMPLETED',
      }));

      const emitCall = spyEmit.mock.calls.find((c) => c[0] === 'webhook.received');
      expect(emitCall?.[1].orderId).toBe(codTrans);
      expect(emitCall?.[1].orderId).not.toBe('VICTIM-ORDER-999');
      expect(emitCall?.[1].orderId).not.toBe('VICTIM-ORDER-888');
    });

    it('should use local mapped orderId if present for Nexi and ignore extra body fields', async () => {
      const configurator = new CheckoutConfigurator();
      const nexi = new NexiProvider({
        merchantId: nexiApiKey,
        macKey: nexiMacKey,
        environment: 'sandbox',
      });
      configurator.registerProvider(nexi);
      configurator.setPaymentOrder('ORD-REAL-456', 'LOCAL-ORDER-123');

      const codTrans = 'ORD-REAL-456';
      const esito = 'OK';
      const importo = '2000';
      const divisa = 'EUR';
      const dataStr = '20260928';
      const orario = '210000';
      const codAut = 'AUTH456';
      const mac = generateNexiOutcomeMac(codTrans, esito, importo, divisa, dataStr, orario, codAut);

      const result = await configurator.handleWebhook('nexi', {
        codTrans,
        esito,
        importo,
        divisa,
        data: dataStr,
        orario,
        codAut,
        mac,
        orderId: 'VICTIM',
      });

      expect(result.orderId).toBe('LOCAL-ORDER-123');
      expect(result.orderId).not.toBe('VICTIM');
    });
  });

  describe('2. Unauthenticated callback: no orderId from query when verification fails', () => {
    it('should not take orderId from query for Satispay when signature is invalid or unsigned', async () => {
      const configurator = new CheckoutConfigurator();
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const satispay = new SatispayProvider({
        keyId: 'k1',
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
        webhookPublicKey: publicKey.export({ type: 'spki', format: 'pem' }) as string,
      });
      configurator.registerProvider(satispay);
      const spyEmit = vi.spyOn(configurator.events, 'emit');

      const result = await configurator.handleWebhook(
        'satispay',
        { payment_id: 'SAT-1' },
        { authorization: 'Signature keyId="k1",algorithm="rsa-sha256",headers="(request-target)",signature="INVALID"' },
        { order_id: 'VICTIM-ORDER' },
        { method: 'POST', path: '/checkout/satispay/webhook' },
      );

      expect(result.success).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.orderId).toBeUndefined();

      expect(spyEmit).toHaveBeenCalledWith('webhook.received', expect.objectContaining({
        provider: 'satispay',
        orderId: undefined,
        verified: false,
      }));
    });

    it('should not take orderId from query for Nexi when MAC is invalid', async () => {
      const configurator = new CheckoutConfigurator();
      const nexi = new NexiProvider({
        merchantId: nexiApiKey,
        macKey: nexiMacKey,
      });
      configurator.registerProvider(nexi);
      const spyEmit = vi.spyOn(configurator.events, 'emit');

      const result = await configurator.handleWebhook(
        'nexi',
        { codTrans: 'ORD-1', esito: 'OK', importo: '100', divisa: 'EUR', mac: '0000000000000000000000000000000000000000' },
        {},
        { order_id: 'VICTIM-ORDER' },
        { method: 'POST' },
      );

      expect(result.success).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.orderId).toBeUndefined();

      expect(spyEmit).toHaveBeenCalledWith('webhook.received', expect.objectContaining({
        provider: 'nexi',
        orderId: undefined,
        verified: false,
      }));
    });
  });

  describe('3. verified: boolean flag in WebhookResult and webhook.received', () => {
    it('returns verified: true on good MAC and verified: false on bad MAC for Nexi', async () => {
      const nexi = new NexiProvider({ merchantId: nexiApiKey, macKey: nexiMacKey });
      const codTrans = 'ORD-V1';
      const mac = generateNexiOutcomeMac(codTrans, 'OK', '1000', 'EUR', '20260928', '120000', 'AUTH');

      const good = await nexi.handleWebhook({
        codTrans,
        esito: 'OK',
        importo: '1000',
        divisa: 'EUR',
        data: '20260928',
        orario: '120000',
        codAut: 'AUTH',
        mac,
      });
      expect(good.verified).toBe(true);
      expect(good.success).toBe(true);

      const bad = await nexi.handleWebhook({
        codTrans,
        esito: 'OK',
        importo: '1000',
        divisa: 'EUR',
        data: '20260928',
        orario: '120000',
        codAut: 'AUTH',
        mac: 'abcdef0123456789abcdef0123456789abcdef01',
      });
      expect(bad.verified).toBe(false);
      expect(bad.success).toBe(false);
      expect(bad.error).toBe('MAC verification failed');
    });

    it('returns verified: true + error on genuine CANCELED Satispay payment', async () => {
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const satispay = new SatispayProvider({
        keyId: 'k1',
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            id: 'SAT-CANCELED-UUID',
            status: 'CANCELED',
            amount_unit: 1000,
            currency: 'EUR',
            external_code: 'ORD-EXT-99',
          }),
        ),
      });
      global.fetch = mockFetch;

      // GET trigger (unsigned GET webhook)
      const result = await satispay.handleWebhook(
        undefined,
        {},
        { payment_id: 'SAT-CANCELED-UUID' },
        { method: 'GET' },
      );

      expect(result.verified).toBe(true);
      expect(result.success).toBe(false);
      expect(result.status).toBe('CANCELED');
      expect(result.error).toBe('Payment is CANCELED');
      expect(result.orderId).toBe('ORD-EXT-99');
    });
  });

  describe('4. Reason phrase leakage, numeric currency, and scoped error masking', () => {
    it('Nexi: does not leak statusText reason phrase in error bodies on API error', async () => {
      const nexi = new NexiProvider({ merchantId: nexiApiKey, macKey: nexiMacKey });
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway Reason Phrase X Leak',
      });

      const result = await nexi.getPaymentDetails('ORD-123');
      expect(result.success).toBe(false);
      expect(result.error).not.toContain('Bad Gateway Reason Phrase X Leak');
      expect(result.error).toContain('Nexi API error: HTTP 502');
    });

    it('Satispay: handles numeric currency without TypeError', async () => {
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const satispay = new SatispayProvider({
        keyId: 'k1',
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            id: 'SAT-NUMERIC-CURRENCY',
            status: 'ACCEPTED',
            amount_unit: 2500,
            currency: 978, // numeric ISO currency for EUR
            external_code: 'ORD-978',
          }),
        ),
      });

      const details = await satispay.getPaymentDetails('SAT-NUMERIC-CURRENCY');
      expect(details.success).toBe(true);
      expect(details.currency).toBe('EUR');
      expect(details.amount).toBe(25);

      const webhookResult = await satispay.handleWebhook(
        undefined,
        {},
        { payment_id: 'SAT-NUMERIC-CURRENCY' },
        { method: 'GET' },
      );
      expect(webhookResult.success).toBe(true);
      expect(webhookResult.verified).toBe(true);
      expect(webhookResult.currency).toBe('EUR');
    });

    it('Express Adapter: only masks errors from providers, not from consumer buildPaymentRequest/hooks', async () => {
      const configurator = new CheckoutConfigurator();
      const nexi = new NexiProvider({ merchantId: nexiApiKey, macKey: nexiMacKey });
      configurator.registerProvider(nexi);

      // Consumer buildPaymentRequest throws an error whose message mentions "JSON"
      const app = express();
      app.use(express.json());
      app.use(
        '/payments',
        createCheckoutRouter(configurator, {
          buildPaymentRequest: async () => {
            throw new Error('Consumer JSON validation error: field X is invalid');
          },
        }),
      );

      const res = await request(app).post('/payments/nexi').send({ item: 'test' });
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      // Consumer error must NOT be masked to "Invalid provider response"
      expect(res.body.error).toBe('Consumer JSON validation error: field X is invalid');
    });

    it('Express Adapter: still masks unhandled provider SyntaxError to Invalid provider response', async () => {
      const configurator = new CheckoutConfigurator();
      const app = express();
      app.use(express.json());
      app.use('/payments', createCheckoutRouter(configurator));

      vi.spyOn(configurator, 'getPaymentDetails').mockImplementation(() => {
        throw new SyntaxError('Unexpected token < in JSON at position 0: <html><body>Upstream error</body></html>');
      });

      const res = await request(app).get('/payments/dummy/err-id');
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid provider response');
      expect(res.body.error).not.toContain('<html>');
    });
  });
});
