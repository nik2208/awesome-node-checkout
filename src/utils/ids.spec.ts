import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import * as crypto from 'crypto';
import { generateOrderId } from './ids';
import { NexiProvider } from '../providers/nexi/nexi.provider';
import { SatispayProvider } from '../providers/satispay/satispay.provider';
import { InMemoryTransactionStore } from '../stores/in-memory-transaction.store';
import * as publicApi from '../index';

const ORDER_ID = /^ORD-[0-9a-f]{24}$/;

describe('generateOrderId (Issue #29)', () => {
  it('matches ORD- followed by 24 hex chars (28 chars, fits Nexi codTrans max 30)', () => {
    const id = generateOrderId();
    expect(id).toMatch(ORDER_ID);
    expect(id.length).toBe(28);
  });

  it('1000 calls produce 1000 distinct values', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateOrderId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(ORDER_ID);
  });

  it('is not exported from the package entry point', () => {
    expect((publicApi as Record<string, unknown>).generateOrderId).toBeUndefined();
  });

  it('Nexi createPayment without orderId yields a random paymentId and codTrans', async () => {
    const nexi = new NexiProvider({ merchantId: 'M', macKey: 'K' });
    const a = await nexi.createPayment({ amount: 10, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' });
    const b = await nexi.createPayment({ amount: 10, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' });
    expect(a.success).toBe(true);
    expect(a.paymentId).toMatch(ORDER_ID);
    expect(new URL(a.approvalUrl!).searchParams.get('codTrans')).toBe(a.paymentId);
    expect(b.paymentId).toMatch(ORDER_ID);
    expect(b.paymentId).not.toBe(a.paymentId);
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

    it('createPayment without orderId sends a random external_code', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify({ id: 'SAT-1', status: 'PENDING' })),
      });
      globalThis.fetch = fetchMock as any;
      const store = new InMemoryTransactionStore();
      const satispay = new SatispayProvider({ keyId: 'k', privateKey, serverUrl: 'https://shop.test', transactionStore: store });

      const result = await satispay.createPayment({ amount: 15, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' });

      expect(result.success).toBe(true);
      const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(sent.external_code).toMatch(ORDER_ID);
      expect(sent.callback_url).toContain(`order_id=${sent.external_code}`);
      expect(await store.get(sent.external_code)).toMatchObject({ orderId: sent.external_code, paymentId: 'SAT-1' });
    });
  });
});
