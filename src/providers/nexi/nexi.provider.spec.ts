import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import { NexiProvider } from './nexi.provider';
import { PaymentRequest } from '../../models/payment-request.model';

// Helper to compute expected SHA-1 MAC (mirrors the private method)
function sha1(raw: string): string {
  return crypto.createHash('sha1').update(raw).digest('hex');
}

describe('NexiProvider', () => {
  const config = {
    merchantId: 'TEST_MERCHANT',
    macKey: 'super-secret-mac-key',
    environment: 'sandbox' as const,
  };

  let provider: NexiProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new NexiProvider(config);
    global.fetch = vi.fn();
  });

  // ---------------------------------------------------------------------------
  // createPayment
  // ---------------------------------------------------------------------------

  it('should create a payment and return an approvalUrl with a valid MAC', async () => {
    const req: PaymentRequest = {
      amount: 19.99,
      currency: 'EUR',
      returnUrl: 'https://myapp.com/success',
      cancelUrl: 'https://myapp.com/cancel',
      orderId: 'ORD-001',
    };

    const result = await provider.createPayment(req);

    expect(result.success).toBe(true);
    expect(result.paymentId).toBe('ORD-001');
    expect(result.approvalUrl).toContain('int-ecommerce.nexi.it');
    expect(result.approvalUrl).toContain('codTrans=ORD-001');
    expect(result.status).toBe('CREATED');

    // Verify MAC in the approval URL
    const url = new URL(result.approvalUrl!);
    const mac = url.searchParams.get('mac');
    const importo = url.searchParams.get('importo'); // 1999
    const expectedMac = sha1(`codTrans=ORD-001divisa=EURimporto=${importo}${config.macKey}`);
    expect(mac).toBe(expectedMac);
  });

  it('should auto-generate orderId when not provided', async () => {
    const req: PaymentRequest = {
      amount: 5.00,
      currency: 'EUR',
      returnUrl: 'https://myapp.com/success',
      cancelUrl: 'https://myapp.com/cancel',
    };

    const result = await provider.createPayment(req);

    expect(result.success).toBe(true);
    expect(result.paymentId).toMatch(/^ORD-\d+$/);
  });

  it('should include gruppo when group is configured', async () => {
    const providerWithGroup = new NexiProvider({ ...config, group: 'TEST_GROUP' });
    const req: PaymentRequest = {
      amount: 10.00,
      currency: 'EUR',
      returnUrl: 'https://myapp.com/success',
      cancelUrl: 'https://myapp.com/cancel',
      orderId: 'ORD-002',
    };

    const result = await providerWithGroup.createPayment(req);

    expect(result.approvalUrl).toContain('gruppo=TEST_GROUP');
  });

  it('should use the production URL when environment is production', async () => {
    const prodProvider = new NexiProvider({ ...config, environment: 'production' });
    const result = await prodProvider.createPayment({
      amount: 10.00,
      currency: 'EUR',
      returnUrl: 'https://myapp.com/success',
      cancelUrl: 'https://myapp.com/cancel',
      orderId: 'ORD-003',
    });

    expect(result.approvalUrl).toContain('ecommerce.nexi.it');
    expect(result.approvalUrl).not.toContain('int-ecommerce.nexi.it');
  });

  // ---------------------------------------------------------------------------
  // executePayment / handleRedirect — MAC verification
  // ---------------------------------------------------------------------------

  it('should confirm payment when esito is OK and MAC is valid', async () => {
    const codTrans = 'ORD-001';
    const esito = 'OK';
    const importo = '1999';
    const divisa = 'EUR';
    const mac = sha1(`codTrans=${codTrans}esito=${esito}importo=${importo}divisa=${divisa}${config.macKey}`);

    const result = await provider.handleRedirect({ codTrans, esito, importo, divisa, mac });

    expect(result.success).toBe(true);
    expect(result.paymentId).toBe(codTrans);
    expect(result.status).toBe('COMPLETED');
  });

  it('should reject payment when POST-back MAC is invalid', async () => {
    const result = await provider.handleRedirect({
      codTrans: 'ORD-001',
      esito: 'OK',
      importo: '1999',
      divisa: 'EUR',
      mac: 'deadbeef00000000000000000000000000000000', // wrong MAC
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/MAC verification failed/);
  });

  it('should mark payment failed when esito is KO and MAC is valid', async () => {
    const codTrans = 'ORD-002';
    const esito = 'KO';
    const importo = '500';
    const divisa = 'EUR';
    const mac = sha1(`codTrans=${codTrans}esito=${esito}importo=${importo}divisa=${divisa}${config.macKey}`);

    const result = await provider.handleRedirect({ codTrans, esito, importo, divisa, mac });

    expect(result.success).toBe(false);
    expect(result.status).toBe('FAILED');
  });

  it('should skip MAC verification when mac field is absent', async () => {
    // Some integrations may omit the MAC in test environments
    const result = await provider.executePayment('ORD-001', {
      codTrans: 'ORD-001',
      esito: 'OK',
      importo: '1999',
      divisa: 'EUR',
      // no mac field
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('COMPLETED');
  });

  // ---------------------------------------------------------------------------
  // getPaymentDetails — MAC must NOT include the raw macKey
  // ---------------------------------------------------------------------------

  it('should call status API with a computed MAC, not the raw macKey', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ status: 'PAID' }),
    });

    await provider.getPaymentDetails('ORD-001');

    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(options.body as string);

    // The macKey must NOT appear in the request body
    expect(body.get('mac')).not.toBe(config.macKey);
    // But a mac field must be present (the computed hash)
    expect(body.get('mac')).toBeTruthy();
    expect(body.get('mac')).toHaveLength(40); // SHA-1 hex is 40 chars
  });

  it('should return payment details on success', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ status: 'PAID' }),
    });

    const result = await provider.getPaymentDetails('ORD-001');

    expect(result.success).toBe(true);
    expect(result.paymentId).toBe('ORD-001');
    expect(result.status).toBe('PAID');
  });

  it('should handle API errors gracefully in getPaymentDetails', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      statusText: 'Internal Server Error',
    });

    const result = await provider.getPaymentDetails('ORD-001');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Nexi API error');
  });

  // ---------------------------------------------------------------------------
  // refundPayment — MAC must NOT include the raw macKey
  // ---------------------------------------------------------------------------

  it('should call refund API with a computed MAC, not the raw macKey', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ esito: 'OK' }),
    });

    await provider.refundPayment('ORD-001', 9.99);

    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(options.body as string);

    expect(body.get('mac')).not.toBe(config.macKey);
    expect(body.get('mac')).toBeTruthy();
    expect(body.get('mac')).toHaveLength(40);
    expect(body.get('importo')).toBe('999'); // 9.99 * 100
  });

  it('should return REFUNDED on successful refund', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ esito: 'OK' }),
    });

    const result = await provider.refundPayment('ORD-001');

    expect(result.success).toBe(true);
    expect(result.status).toBe('REFUNDED');
  });

  it('should return REFUND_FAILED when refund esito is not OK', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ esito: 'KO' }),
    });

    const result = await provider.refundPayment('ORD-001');

    expect(result.success).toBe(false);
    expect(result.status).toBe('REFUND_FAILED');
  });

  it('should handle network errors in refundPayment', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network failure'));

    const result = await provider.refundPayment('ORD-001');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Network failure');
  });
});
