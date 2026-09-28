import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import { NexiProvider } from './nexi.provider';
import { CheckoutConfigurator } from '../../checkout-configurator';
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

  it('should set urlpost when notifyUrl is provided, and keep MAC identical', async () => {
    const baseReq: PaymentRequest = {
      amount: 19.99,
      currency: 'EUR',
      orderId: 'ORD-001',
      returnUrl: 'https://shop.test/ok',
      cancelUrl: 'https://shop.test/ko',
    };

    const resultNoNotify = await provider.createPayment(baseReq);
    const urlNoNotify = new URL(resultNoNotify.approvalUrl!);
    expect(urlNoNotify.searchParams.get('urlpost')).toBeNull();

    const resultWithNotify = await provider.createPayment({
      ...baseReq,
      notifyUrl: 'https://shop.test/checkout/nexi/webhook',
    });
    const urlWithNotify = new URL(resultWithNotify.approvalUrl!);
    expect(urlWithNotify.searchParams.get('urlpost')).toBe('https://shop.test/checkout/nexi/webhook');
    expect(urlWithNotify.searchParams.get('mac')).toBe(urlNoNotify.searchParams.get('mac'));
  });

  // ---------------------------------------------------------------------------
  // executePayment / handleRedirect — Outcome MAC verification
  // ---------------------------------------------------------------------------

  it('should reject the outcome when mac is absent or empty', async () => {
    const resMissing = await provider.handleRedirect({ codTrans: 'ORD-42', esito: 'OK' });
    expect(resMissing).toEqual({
      success: false,
      paymentId: undefined,
      status: 'FAILED',
      error: 'MAC missing',
    });

    const resEmpty = await provider.executePayment('ORD-42', { esito: 'OK', mac: '' });
    expect(resEmpty).toEqual({
      success: false,
      paymentId: undefined,
      status: 'FAILED',
      error: 'MAC missing',
    });
  });

  it('should emit payment.failed and never payment.completed when mac is missing in handleRedirect', async () => {
    const checkout = new CheckoutConfigurator().registerProvider(provider);
    const spyEmit = vi.spyOn(checkout.events, 'emit');

    const result = await checkout.handleRedirect('nexi', { codTrans: 'ORD-42', esito: 'OK' });

    expect(result.success).toBe(false);
    expect(result.status).toBe('FAILED');
    expect(spyEmit).toHaveBeenCalledWith('payment.failed', expect.objectContaining({
      provider: 'nexi',
      paymentId: undefined,
      status: 'FAILED',
      error: 'MAC missing',
    }));
    expect(spyEmit).not.toHaveBeenCalledWith('payment.completed', expect.anything());
  });

  it('should confirm payment when esito is OK and 7-field MAC is valid', async () => {
    const codTrans = 'ORD-001';
    const esito = 'OK';
    const importo = '1999';
    const divisa = 'EUR';
    const dataStr = '20260927';
    const orario = '120000';
    const codAut = 'AUTH123';
    const mac = sha1(`codTrans=${codTrans}esito=${esito}importo=${importo}divisa=${divisa}data=${dataStr}orario=${orario}codAut=${codAut}${config.macKey}`);

    const result = await provider.handleRedirect({
      codTrans,
      esito,
      importo,
      divisa,
      data: dataStr,
      orario,
      codAut,
      mac,
    });

    expect(result.success).toBe(true);
    expect(result.paymentId).toBe(codTrans);
    expect(result.status).toBe('COMPLETED');
    expect(result.amount).toBe(19.99);
    expect(result.currency).toBe('EUR');
  });

  it('should mark payment failed when esito is KO and 7-field MAC is valid', async () => {
    const codTrans = 'ORD-002';
    const esito = 'KO';
    const importo = '500';
    const divisa = 'EUR';
    const dataStr = '20260927';
    const orario = '120000';
    const codAut = '';
    const mac = sha1(`codTrans=${codTrans}esito=${esito}importo=${importo}divisa=${divisa}data=${dataStr}orario=${orario}codAut=${codAut}${config.macKey}`);

    const result = await provider.handleRedirect({
      codTrans,
      esito,
      importo,
      divisa,
      data: dataStr,
      orario,
      codAut,
      mac,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('FAILED');
    expect(result.amount).toBe(5);
    expect(result.currency).toBe('EUR');
  });

  it('should reject a MAC computed with the old 4-field formula', async () => {
    const codTrans = 'ORD-001';
    const esito = 'OK';
    const importo = '1999';
    const divisa = 'EUR';
    const old4FieldMac = sha1(`codTrans=${codTrans}esito=${esito}importo=${importo}divisa=${divisa}${config.macKey}`);

    const result = await provider.handleRedirect({
      codTrans,
      esito,
      importo,
      divisa,
      data: '20260927',
      orario: '120000',
      codAut: 'AUTH123',
      mac: old4FieldMac,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('FAILED');
    expect(result.error).toMatch(/MAC verification failed/);
  });

  it('should reject when any one signed field is tampered with', async () => {
    const codTrans = 'ORD-001';
    const esito = 'OK';
    const importo = '1999';
    const divisa = 'EUR';
    const dataStr = '20260927';
    const orario = '120000';
    const codAut = 'AUTH123';
    const mac = sha1(`codTrans=${codTrans}esito=${esito}importo=${importo}divisa=${divisa}data=${dataStr}orario=${orario}codAut=${codAut}${config.macKey}`);

    // Tamper importo
    const resTamperedImporto = await provider.handleRedirect({
      codTrans,
      esito,
      importo: '1',
      divisa,
      data: dataStr,
      orario,
      codAut,
      mac,
    });
    expect(resTamperedImporto.success).toBe(false);
    expect(resTamperedImporto.error).toMatch(/MAC verification failed/);

    // Tamper codAut
    const resTamperedAuth = await provider.handleRedirect({
      codTrans,
      esito,
      importo,
      divisa,
      data: dataStr,
      orario,
      codAut: 'HACKED',
      mac,
    });
    expect(resTamperedAuth.success).toBe(false);
    expect(resTamperedAuth.error).toMatch(/MAC verification failed/);
  });

  it('should reject non-hex or invalid length MAC', async () => {
    const codTrans = 'ORD-001';
    const esito = 'OK';
    const importo = '1999';
    const divisa = 'EUR';
    const dataStr = '20260927';
    const orario = '120000';
    const codAut = 'AUTH123';

    // 42 characters or invalid hex characters
    const resInvalidLen = await provider.handleRedirect({
      codTrans, esito, importo, divisa, data: dataStr, orario, codAut,
      mac: 'a'.repeat(42),
    });
    expect(resInvalidLen.success).toBe(false);
    expect(resInvalidLen.error).toMatch(/MAC verification failed/);

    const resNonHex = await provider.handleRedirect({
      codTrans, esito, importo, divisa, data: dataStr, orario, codAut,
      mac: 'z'.repeat(40),
    });
    expect(resNonHex.success).toBe(false);
    expect(resNonHex.error).toMatch(/MAC verification failed/);
  });

  it('should leave amount undefined when importo is empty or missing', async () => {
    const codTrans = 'ORD-001';
    const esito = 'OK';
    const importo = '';
    const divisa = 'EUR';
    const dataStr = '';
    const orario = '';
    const codAut = '';
    const mac = sha1(`codTrans=${codTrans}esito=${esito}importo=${importo}divisa=${divisa}data=${dataStr}orario=${orario}codAut=${codAut}${config.macKey}`);

    const result = await provider.handleRedirect({
      codTrans,
      esito,
      importo,
      divisa,
      mac,
    });

    expect(result.success).toBe(false);
    expect(result.amount).toBeUndefined();
    expect(result.error).toContain('Payment amount is missing or invalid');
  });

  // ---------------------------------------------------------------------------
  // handleWebhook — server-to-server outcome notification
  // ---------------------------------------------------------------------------

  it('should process valid server-to-server webhook notification', async () => {
    const codTrans = 'ORD-001';
    const esito = 'OK';
    const importo = '1999';
    const divisa = 'EUR';
    const dataStr = '20260927';
    const orario = '120000';
    const codAut = 'AUTH123';
    const mac = sha1(`codTrans=${codTrans}esito=${esito}importo=${importo}divisa=${divisa}data=${dataStr}orario=${orario}codAut=${codAut}${config.macKey}`);

    const result = await provider.handleWebhook({
      codTrans,
      esito,
      importo,
      divisa,
      data: dataStr,
      orario,
      codAut,
      mac,
    }, {});

    expect(result.success).toBe(true);
    expect(result.paymentId).toBe('ORD-001');
    expect(result.status).toBe('COMPLETED');
    expect(result.amount).toBe(19.99);
    expect(result.currency).toBe('EUR');
    expect(result.raw).toBeDefined();
  });

  it('should return failed webhook result when esito is KO and MAC is valid', async () => {
    const codTrans = 'ORD-001';
    const esito = 'KO';
    const importo = '1999';
    const divisa = 'EUR';
    const dataStr = '20260927';
    const orario = '120000';
    const codAut = '';
    const mac = sha1(`codTrans=${codTrans}esito=${esito}importo=${importo}divisa=${divisa}data=${dataStr}orario=${orario}codAut=${codAut}${config.macKey}`);

    const result = await provider.handleWebhook({
      codTrans,
      esito,
      importo,
      divisa,
      data: dataStr,
      orario,
      codAut,
      mac,
    }, {});

    expect(result.success).toBe(false);
    expect(result.status).toBe('FAILED');
    expect(result.amount).toBe(19.99);
  });

  it('should reject webhook with missing, wrong, or short MAC without throwing', async () => {
    const resNoMac = await provider.handleWebhook({ codTrans: 'ORD-1' }, {});
    expect(resNoMac.success).toBe(false);
    expect(resNoMac.error).toBe('MAC verification failed');
    expect(resNoMac.status).toBeUndefined();

    const resWrongMac = await provider.handleWebhook({
      codTrans: 'ORD-1',
      mac: 'deadbeef' + '0'.repeat(32),
    }, {});
    expect(resWrongMac.success).toBe(false);
    expect(resWrongMac.error).toBe('MAC verification failed');
    expect(resWrongMac.status).toBeUndefined();

    const resShortMac = await provider.handleWebhook({
      codTrans: 'ORD-1',
      mac: 'abc',
    }, {});
    expect(resShortMac.success).toBe(false);
    expect(resShortMac.error).toBe('MAC verification failed');
    expect(resShortMac.status).toBeUndefined();
  });

  it('should handle undefined or empty webhook body without throwing', async () => {
    const resEmpty = await provider.handleWebhook({}, {});
    expect(resEmpty.success).toBe(false);
    expect(resEmpty.error).toBe('MAC verification failed');

    const resUndef = await provider.handleWebhook(undefined as any, {});
    expect(resUndef.success).toBe(false);
    expect(resUndef.error).toBe('MAC verification failed');
  });

  it('CheckoutConfigurator.handleWebhook should support nexi without throwing WEBHOOK_NOT_SUPPORTED', async () => {
    const checkout = new CheckoutConfigurator().registerProvider(provider);
    const codTrans = 'ORD-001';
    const esito = 'OK';
    const importo = '1999';
    const divisa = 'EUR';
    const mac = sha1(`codTrans=${codTrans}esito=${esito}importo=${importo}divisa=${divisa}data=orario=codAut=${config.macKey}`);

    const result = await checkout.handleWebhook('nexi', { codTrans, esito, importo, divisa, mac }, {});
    expect(result.success).toBe(true);
    expect(result.paymentId).toBe('ORD-001');
  });

  // ---------------------------------------------------------------------------
  // getPaymentDetails — XPay Back-Office situazionOrdine API
  // ---------------------------------------------------------------------------

  it('should call XPay back-office order status API with correct JSON payload and MAC', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const expectedMac = sha1(`apiKey=TEST_MERCHANTcodiceTransazione=ORD-001timeStamp=1700000000000${config.macKey}`);
    const respMac = sha1(`esito=OKidOperazione=OP-1timeStamp=1700000000001${config.macKey}`);

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        esito: 'OK',
        idOperazione: 'OP-1',
        timeStamp: '1700000000001',
        mac: respMac,
        report: [{
          codiceTransazione: 'ORD-001',
          stato: 'Contabilizzato',
          importo: '1999',
          divisa: '978',
        }],
      }),
    });

    const result = await provider.getPaymentDetails('ORD-001');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://int-ecommerce.nexi.it/ecomm/api/bo/situazioneOrdine');
    expect(options.method).toBe('POST');
    expect((options.headers as any)['Content-Type']).toBe('application/json');

    const parsedBody = JSON.parse(options.body as string);
    expect(parsedBody).toEqual({
      apiKey: 'TEST_MERCHANT',
      codiceTransazione: 'ORD-001',
      timeStamp: '1700000000000',
      mac: expectedMac,
    });

    expect(result).toMatchObject({
      success: true,
      paymentId: 'ORD-001',
      status: 'Contabilizzato',
      amount: 19.99,
      currency: 'EUR',
    });
  });

  it('should use production URL for getPaymentDetails when environment is production', async () => {
    const prodProvider = new NexiProvider({ ...config, environment: 'production' });
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const respMac = sha1(`esito=OKidOperazione=OP-1timeStamp=1700000000001${config.macKey}`);

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        esito: 'OK',
        idOperazione: 'OP-1',
        timeStamp: '1700000000001',
        mac: respMac,
        report: [{ codiceTransazione: 'ORD-001', stato: 'Autorizzato', importo: '1000', divisa: 'EUR' }],
      }),
    });

    await prodProvider.getPaymentDetails('ORD-001');
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ecommerce.nexi.it/ecomm/api/bo/situazioneOrdine');
  });

  it('should reject response when response MAC is missing or invalid', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        esito: 'OK',
        idOperazione: 'OP-1',
        timeStamp: '1700000000001',
        mac: 'deadbeef',
        report: [{ codiceTransazione: 'ORD-001', stato: 'Contabilizzato', importo: '1999', divisa: '978' }],
      }),
    });

    const result = await provider.getPaymentDetails('ORD-001');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/MAC verification failed/);
  });

  it('should return failure when esito is KO without leaking error message', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        esito: 'KO',
        errore: { messaggio: 'Transazione non trovata' },
      }),
    });

    const result = await provider.getPaymentDetails('ORD-001');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Payment details request failed');
    expect(result.error).not.toContain('Transazione non trovata');
  });

  it('should return failure when report is empty or missing', async () => {
    const respMac = sha1(`esito=OKidOperazione=OP-1timeStamp=1700000000001${config.macKey}`);
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        esito: 'OK',
        idOperazione: 'OP-1',
        timeStamp: '1700000000001',
        mac: respMac,
        report: [],
      }),
    });

    const result = await provider.getPaymentDetails('ORD-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Report not found');
  });

  it('should return failure when report does not contain the requested transaction (no report[0] fallback)', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const respMac = sha1(`esito=OKidOperazione=OP-1timeStamp=1700000000001${config.macKey}`);

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        esito: 'OK',
        idOperazione: 'OP-1',
        timeStamp: '1700000000001',
        mac: respMac,
        report: [{
          codiceTransazione: 'ORD-OTHER',
          stato: 'Contabilizzato',
          importo: '1000',
          divisa: 'EUR',
        }],
      }),
    });

    const result = await provider.getPaymentDetails('ORD-MY-ORDER');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Report not found');
  });

  it('should map numeric currency codes and handle unknown codes and empty amount in getPaymentDetails', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const respMac = sha1(`esito=OKidOperazione=OP-1timeStamp=1700000000001${config.macKey}`);

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        esito: 'OK',
        idOperazione: 'OP-1',
        timeStamp: '1700000000001',
        mac: respMac,
        report: [{
          codiceTransazione: 'ORD-USD',
          stato: 'Contabilizzato',
          importo: '1500',
          divisa: '840', // USD
        }],
      }),
    });

    const resUsd = await provider.getPaymentDetails('ORD-USD');
    expect(resUsd.success).toBe(true);
    expect(resUsd.currency).toBe('USD');
    expect(resUsd.amount).toBe(15);

    // Unknown currency and empty amount
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        esito: 'OK',
        idOperazione: 'OP-1',
        timeStamp: '1700000000001',
        mac: respMac,
        report: [{
          codiceTransazione: 'ORD-UNKNOWN',
          stato: 'Contabilizzato',
          importo: '',
          divisa: '9999',
        }],
      }),
    });

    const resUnknown = await provider.getPaymentDetails('ORD-UNKNOWN');
    expect(resUnknown.success).toBe(false);
    expect(resUnknown.currency).toBeUndefined();
    expect(resUnknown.amount).toBeUndefined();
    expect(resUnknown.error).toContain('Payment amount is missing or invalid');
  });

  it('should return success: false when status is not paid or amount is missing in getPaymentDetails', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const respMac = sha1(`esito=OKidOperazione=OP-1timeStamp=1700000000001${config.macKey}`);

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        esito: 'OK',
        idOperazione: 'OP-1',
        timeStamp: '1700000000001',
        mac: respMac,
        report: [{
          codiceTransazione: 'ORD-CANCELLED',
          stato: 'Annullato',
          importo: '1500',
          divisa: 'EUR',
        }],
      }),
    });

    const result = await provider.getPaymentDetails('ORD-CANCELLED');
    expect(result.success).toBe(false);
    expect(result.status).toBe('Annullato');
    expect(result.error).toContain('Payment status is Annullato');
  });

  it('should return success: false when amount is empty or missing in executePayment or handleWebhook', async () => {
    const codTrans = 'ORD-001';
    const esito = 'OK';
    const importo = '';
    const divisa = 'EUR';
    const dataStr = '20260927';
    const orario = '120000';
    const codAut = 'AUTH123';
    const mac = sha1(`codTrans=${codTrans}esito=${esito}importo=${importo}divisa=${divisa}data=${dataStr}orario=${orario}codAut=${codAut}${config.macKey}`);

    const execResult = await provider.executePayment(codTrans, { codTrans, esito, importo, divisa, data: dataStr, orario, codAut, mac });
    expect(execResult.success).toBe(false);
    expect(execResult.error).toContain('Payment amount is missing or invalid');

    const webhookResult = await provider.handleWebhook({ codTrans, esito, importo, divisa, data: dataStr, orario, codAut, mac });
    expect(webhookResult.success).toBe(false);
    expect(webhookResult.error).toContain('Payment amount is missing or invalid');
  });

  it('should handle API HTTP errors gracefully in getPaymentDetails', async () => {
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

  describe('Issue #21 residuals', () => {
    it('should return Invalid provider response on non-JSON 200 in getPaymentDetails and refundPayment', async () => {
      // getPaymentDetails non-JSON 200
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token < in JSON at position 0')),
      });

      const detailsResult = await provider.getPaymentDetails('ORD-001');
      expect(detailsResult.success).toBe(false);
      expect(detailsResult.error).toBe('Invalid provider response');

      // refundPayment non-JSON 200
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token < in JSON at position 0')),
      });

      const refundResult = await provider.refundPayment('ORD-001');
      expect(refundResult.success).toBe(false);
      expect(refundResult.error).toBe('Invalid provider response');
    });

    it('should return success: false when amount is 0 or negative in executePayment, handleWebhook, and getPaymentDetails', async () => {
      const dataStr = '20231114';
      const orario = '123456';
      const codAut = 'AUTH01';

      // 1. executePayment with amount = 0
      const macZero = sha1(`codTrans=ORD-Zesito=OKimporto=0divisa=EURdata=${dataStr}orario=${orario}codAut=${codAut}${config.macKey}`);
      const resExecZero = await provider.executePayment('ORD-Z', {
        codTrans: 'ORD-Z',
        esito: 'OK',
        importo: '0',
        divisa: 'EUR',
        data: dataStr,
        orario,
        codAut,
        mac: macZero,
      });
      expect(resExecZero.success).toBe(false);
      expect(resExecZero.amount).toBe(0);
      expect(resExecZero.error).toBe('Payment amount is missing or invalid');

      // 2. handleWebhook with amount = -100
      const macNeg = sha1(`codTrans=ORD-Nesito=OKimporto=-100divisa=EURdata=${dataStr}orario=${orario}codAut=${codAut}${config.macKey}`);
      const resWebNeg = await provider.handleWebhook({
        codTrans: 'ORD-N',
        esito: 'OK',
        importo: '-100',
        divisa: 'EUR',
        data: dataStr,
        orario,
        codAut,
        mac: macNeg,
      });
      expect(resWebNeg.success).toBe(false);
      expect(resWebNeg.amount).toBeUndefined();
      expect(resWebNeg.error).toBe('Payment amount is missing or invalid');

      // 3. getPaymentDetails with missing currency
      const respMac = sha1(`esito=OKidOperazione=OP-NCtimeStamp=1700000000001${config.macKey}`);
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          esito: 'OK',
          idOperazione: 'OP-NC',
          timeStamp: '1700000000001',
          mac: respMac,
          report: [{
            codiceTransazione: 'ORD-NC',
            stato: 'Contabilizzato',
            importo: '5000',
            divisa: 'INVALID_CURR',
          }],
        }),
      });

      const resDetailsNoCurr = await provider.getPaymentDetails('ORD-NC');
      expect(resDetailsNoCurr.success).toBe(false);
      expect(resDetailsNoCurr.currency).toBeUndefined();
      expect(resDetailsNoCurr.error).toBe('Payment currency is missing or invalid');
    });
  });
});
