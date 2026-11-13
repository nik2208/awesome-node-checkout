import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import * as crypto from 'crypto';
import { currencyExponent, toMajorString, toMinorUnits } from './money';
import { CheckoutError } from '../models/errors';
import { NexiProvider } from '../providers/nexi/nexi.provider';
import { PayPalProvider } from '../providers/paypal/paypal.provider';
import { SatispayProvider } from '../providers/satispay/satispay.provider';

function expectInvalidAmount(fn: () => unknown): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(CheckoutError);
  expect((thrown as CheckoutError).code).toBe('INVALID_AMOUNT');
}

describe('money utils (Issue #29)', () => {
  describe('currencyExponent', () => {
    it.each(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'])(
      '%s has exponent 0',
      (code) => expect(currencyExponent(code)).toBe(0),
    );
    it.each(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'])('%s has exponent 3', (code) => {
      expect(currencyExponent(code)).toBe(3);
    });
    it.each(['EUR', 'USD', 'GBP', 'CHF', 'XYZ', ''])('%j has exponent 2', (code) => {
      expect(currencyExponent(code)).toBe(2);
    });
    it('normalizes case and whitespace', () => {
      expect(currencyExponent(' jpy ')).toBe(0);
      expect(currencyExponent('kwd')).toBe(3);
    });
  });

  describe('toMinorUnits', () => {
    it.each([
      [19.99, 'EUR', 1999],
      [0.1 + 0.2, 'EUR', 30],
      [1000, 'JPY', 1000],
      [1.234, 'KWD', 1234],
      [0.01, 'EUR', 1],
    ])('(%s, %s) -> %s', (amount, currency, expected) => {
      expect(toMinorUnits(amount, currency)).toBe(expected);
    });

    it.each([
      [19.999, 'EUR'],
      [10.5, 'JPY'],
      [0, 'EUR'],
      [-1, 'EUR'],
      [NaN, 'EUR'],
      [Infinity, 'EUR'],
      [-Infinity, 'EUR'],
      [1.2345, 'KWD'],
      [1.005, 'EUR'],
      [1e300, 'EUR'],
    ])('throws INVALID_AMOUNT for (%s, %s)', (amount, currency) => {
      expectInvalidAmount(() => toMinorUnits(amount, currency));
    });

    it('throws INVALID_AMOUNT for non-number amounts', () => {
      expectInvalidAmount(() => toMinorUnits('10' as any, 'EUR'));
      expectInvalidAmount(() => toMinorUnits(undefined as any, 'EUR'));
    });

    it('the error message mentions the amount and never says JSON', () => {
      let thrown: unknown;
      try {
        toMinorUnits(19.999, 'EUR');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CheckoutError);
      const message = (thrown as Error).message;
      expect(message).toContain('amount');
      expect(message).toContain('19.999');
      expect(message).not.toMatch(/JSON/i);
    });
  });

  describe('toMajorString', () => {
    it.each([
      [1000, 'JPY', '1000'],
      [19.9, 'EUR', '19.90'],
      [1.2, 'KWD', '1.200'],
      [0.05, 'EUR', '0.05'],
      [19.99, 'EUR', '19.99'],
      [0.001, 'KWD', '0.001'],
    ])('(%s, %s) -> %j', (amount, currency, expected) => {
      expect(toMajorString(amount, currency)).toBe(expected);
    });

    it('throws INVALID_AMOUNT like toMinorUnits', () => {
      expectInvalidAmount(() => toMajorString(10.5, 'JPY'));
      expectInvalidAmount(() => toMajorString(19.999, 'EUR'));
    });
  });

  describe('Nexi', () => {
    const nexi = new NexiProvider({ merchantId: 'M', macKey: 'K' });
    const base = { currency: 'EUR', orderId: 'ORD-1', returnUrl: 'https://r', cancelUrl: 'https://c' };

    it('createPayment with 19.999 EUR fails with an amount error and builds no approvalUrl', async () => {
      const result = await nexi.createPayment({ ...base, amount: 19.999 });
      expect(result.success).toBe(false);
      expect(result.status).toBe('FAILED');
      expect(result.error).toContain('amount');
      expect(result.approvalUrl).toBeUndefined();
    });

    it('createPayment with 19.99 EUR puts importo=1999 in the approvalUrl', async () => {
      const result = await nexi.createPayment({ ...base, amount: 19.99 });
      expect(result.success).toBe(true);
      expect(new URL(result.approvalUrl!).searchParams.get('importo')).toBe('1999');
    });

    it.each(['JPY', 'KWD', '392', 'jpy'])(
      'createPayment rejects %j (not 2 decimals: read-back and refunds are in hundredths) and builds no approvalUrl',
      async (currency) => {
        const result = await nexi.createPayment({ ...base, currency, amount: 1000 });
        expect(result).toMatchObject({ success: false, status: 'FAILED' });
        expect(result.error).toContain('currency');
        expect(result.approvalUrl).toBeUndefined();
      },
    );

    it.each([
      ['USD', 'USD'],
      ['840', '840'],
    ])('createPayment with 2-decimal currency %j still succeeds', async (currency, divisa) => {
      const result = await nexi.createPayment({ ...base, currency, amount: 19.99 });
      expect(result.success).toBe(true);
      const params = new URL(result.approvalUrl!).searchParams;
      expect(params.get('importo')).toBe('1999');
      expect(params.get('divisa')).toBe(divisa);
    });

    it('a 19.99 EUR payment round-trips: the MACed outcome reports 19.99 and a 5 EUR refund sends importo=500', async () => {
      const created = await nexi.createPayment({ ...base, amount: 19.99 });
      const importo = new URL(created.approvalUrl!).searchParams.get('importo')!;
      const fields = { codTrans: 'ORD-1', esito: 'OK', importo, divisa: 'EUR', data: '20260101', orario: '120000', codAut: 'A1' };
      const mac = crypto
        .createHash('sha1')
        .update(
          `codTrans=${fields.codTrans}esito=${fields.esito}importo=${fields.importo}divisa=${fields.divisa}` +
            `data=${fields.data}orario=${fields.orario}codAut=${fields.codAut}K`,
        )
        .digest('hex');
      const outcome = await nexi.handleWebhook({ ...fields, mac }, {});
      expect(outcome).toMatchObject({ verified: true, amount: 19.99, currency: 'EUR' });

      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ esito: 'OK' }) });
      globalThis.fetch = fetchMock as any;
      try {
        await nexi.refundPayment('ORD-1', 5);
        const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
        expect(body.get('importo')).toBe('500');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('refundPayment with amount 0 or null fails instead of refunding in full, without calling the API', async () => {
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as any;
      try {
        const result = await nexi.refundPayment('ORD-1', 0);
        expect(result).toMatchObject({ success: false, status: 'FAILED' });
        expect(result.error).toContain('amount');
        // A JSON null through the router fails too, as on PayPal
        const nullResult = await nexi.refundPayment('ORD-1', null as any);
        expect(nullResult).toMatchObject({ success: false, status: 'FAILED' });
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('refundPayment with excess decimals fails without calling the API', async () => {
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as any;
      try {
        const result = await nexi.refundPayment('ORD-1', 9.999);
        expect(result).toMatchObject({ success: false, status: 'FAILED' });
        expect(result.error).toContain('amount');
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('Satispay', () => {
    let privateKey: string;
    const originalFetch = globalThis.fetch;

    beforeAll(() => {
      privateKey = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).privateKey;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('createPayment sends exact amount_unit and rejects excess decimals without calling the API', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify({ id: 'SAT-1', status: 'PENDING' })),
      });
      globalThis.fetch = fetchMock as any;
      const satispay = new SatispayProvider({ keyId: 'k', privateKey });
      const base = { currency: 'EUR', orderId: 'O1', returnUrl: 'https://r', cancelUrl: 'https://c' };

      const ok = await satispay.createPayment({ ...base, amount: 19.99 });
      expect(ok.success).toBe(true);
      expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).amount_unit).toBe(1999);

      const bad = await satispay.createPayment({ ...base, amount: 19.999 });
      expect(bad).toMatchObject({ success: false, status: 'FAILED' });
      expect(bad.error).toContain('amount');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('Satispay currency and refund guards', () => {
    let privateKey: string;
    const originalFetch = globalThis.fetch;

    beforeAll(() => {
      privateKey = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).privateKey;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it.each(['JPY', 'KWD', '392'])('createPayment rejects %j without calling the API', async (currency) => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as any;
      const satispay = new SatispayProvider({ keyId: 'k', privateKey });
      const result = await satispay.createPayment({
        amount: 1000,
        currency,
        orderId: 'O1',
        returnUrl: 'https://r',
        cancelUrl: 'https://c',
      });
      expect(result).toMatchObject({ success: false, status: 'FAILED' });
      expect(result.error).toContain('currency');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refundPayment with amount 0 or null fails instead of refunding in full, without calling the API', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as any;
      const satispay = new SatispayProvider({ keyId: 'k', privateKey });
      const result = await satispay.refundPayment('SAT-1', 0);
      expect(result).toMatchObject({ success: false, status: 'FAILED' });
      expect(result.error).toContain('amount');
      const nullResult = await satispay.refundPayment('SAT-1', null as any);
      expect(nullResult).toMatchObject({ success: false, status: 'FAILED' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refundPayment with an omitted amount still refunds in full: it reads the payment, then refunds its amount_unit (#44)', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: vi.fn().mockResolvedValue(JSON.stringify({ id: 'SAT-1', status: 'ACCEPTED', amount_unit: 1999, currency: 'EUR' })),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: vi.fn().mockResolvedValue(
            JSON.stringify({ id: 'REF-1', type: 'REFUND_TO_BUSINESS', status: 'ACCEPTED', amount_unit: 1999, currency: 'EUR' }),
          ),
        });
      globalThis.fetch = fetchMock as any;
      const satispay = new SatispayProvider({ keyId: 'k', privateKey });
      const result = await satispay.refundPayment('SAT-1');
      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('GET');
      expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
        flow: 'REFUND',
        parent_payment_uid: 'SAT-1',
        amount_unit: 1999,
        currency: 'EUR',
      });
    });
  });

  describe('PayPal', () => {
    function paypalWith(createOrder: ReturnType<typeof vi.fn>): PayPalProvider {
      const paypal = new PayPalProvider({ clientId: 'a', clientSecret: 'b' });
      (paypal as any).ordersController = { createOrder };
      return paypal;
    }
    const base = { returnUrl: 'https://r', cancelUrl: 'https://c' };
    const created = { result: { id: 'PP1', status: 'CREATED', links: [{ rel: 'approve', href: 'https://pp/approve' }] } };

    it("createPayment with { amount: 1000, currency: 'JPY' } sends value '1000'", async () => {
      const createOrder = vi.fn().mockResolvedValue(created);
      const result = await paypalWith(createOrder).createPayment({ ...base, amount: 1000, currency: 'JPY' });
      expect(result.success).toBe(true);
      expect(createOrder).toHaveBeenCalledTimes(1);
      const unit = createOrder.mock.calls[0][0].body.purchaseUnits[0];
      expect(unit.amount).toEqual({ currencyCode: 'JPY', value: '1000' });
    });

    it("createPayment with 1.2 KWD sends value '1.200' and 19.9 EUR sends '19.90'", async () => {
      const createOrder = vi.fn().mockResolvedValue(created);
      const paypal = paypalWith(createOrder);
      await paypal.createPayment({ ...base, amount: 1.2, currency: 'KWD' });
      await paypal.createPayment({ ...base, amount: 19.9, currency: 'EUR' });
      expect(createOrder.mock.calls[0][0].body.purchaseUnits[0].amount.value).toBe('1.200');
      expect(createOrder.mock.calls[1][0].body.purchaseUnits[0].amount.value).toBe('19.90');
    });

    it('createPayment with 10.5 JPY fails and never calls the API', async () => {
      const createOrder = vi.fn().mockResolvedValue(created);
      const result = await paypalWith(createOrder).createPayment({ ...base, amount: 10.5, currency: 'JPY' });
      expect(result).toMatchObject({ success: false, status: 'FAILED' });
      expect(result.error).toContain('amount');
      expect(createOrder).not.toHaveBeenCalled();
    });

    it("refundPayment formats the amount in the order's currency", async () => {
      const paypal = new PayPalProvider({ clientId: 'a', clientSecret: 'b' });
      (paypal as any).ordersController = {
        getOrder: vi.fn().mockResolvedValue({
          result: { id: 'PP1', purchaseUnits: [{ amount: { currencyCode: 'JPY' }, payments: { captures: [{ id: 'CAP1' }] } }] },
        }),
      };
      const refundCapturedPayment = vi.fn().mockResolvedValue({ result: { id: 'REF1', status: 'COMPLETED' } });
      (paypal as any).paymentsController = { refundCapturedPayment };

      const ok = await paypal.refundPayment('PP1', 500);
      expect(ok.success).toBe(true);
      expect(refundCapturedPayment.mock.calls[0][0].body.amount).toEqual({ value: '500', currencyCode: 'JPY' });

      const bad = await paypal.refundPayment('PP1', 1.5);
      expect(bad).toMatchObject({ success: false, status: 'FAILED' });
      expect(refundCapturedPayment).toHaveBeenCalledTimes(1);
    });
  });
});
