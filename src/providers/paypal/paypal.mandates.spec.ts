import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PayPalProvider } from './paypal.provider';
import { CheckoutConfigurator } from '../../checkout-configurator';
import { isMandateProvider } from '../../interfaces/mandate-provider.interface';
import type { CheckoutConfig } from '../../models/checkout-config.model';
import { Mandate, MandatePendingState, MandateSetupRequest } from '../../models/mandate.model';

// Mock of PayPal Server SDK v2.5 (no enum objects: the provider writes string literals)
const sdk = vi.hoisted(() => {
  class ApiError extends Error {
    statusCode: number;
    result: unknown;
    body: string;
    // Like the real SDK error: carries the request with its bearer token
    request = { headers: { authorization: 'Bearer SECRET-TOKEN' } };
    constructor(statusCode: number, result?: unknown) {
      super(`HTTP ${statusCode}`);
      this.name = 'ApiError';
      this.statusCode = statusCode;
      this.result = result;
      this.body = result === undefined ? '' : JSON.stringify(result);
    }
  }
  return {
    ApiError,
    createOrder: vi.fn(),
    captureOrder: vi.fn(),
    getOrder: vi.fn(),
    refundCapturedPayment: vi.fn(),
    getPaymentToken: vi.fn(),
    deletePaymentToken: vi.fn(),
  };
});

vi.mock('@paypal/paypal-server-sdk', () => ({
  Environment: {
    Sandbox: class { constructor() {} },
    Production: class { constructor() {} },
  },
  LogLevel: { Error: 'error' },
  Client: class { constructor() {} },
  OrdersController: class {
    createOrder = sdk.createOrder;
    captureOrder = sdk.captureOrder;
    getOrder = sdk.getOrder;
  },
  PaymentsController: class {
    refundCapturedPayment = sdk.refundCapturedPayment;
  },
  VaultController: class {
    getPaymentToken = sdk.getPaymentToken;
    deletePaymentToken = sdk.deletePaymentToken;
  },
  ApiError: sdk.ApiError,
}));

const { ApiError } = sdk;
const apiError = (status: number, issue?: string) =>
  new ApiError(
    status,
    issue
      ? { name: 'UNPROCESSABLE_ENTITY', message: 'refused', debug_id: 'dbg-1', details: [{ issue }] }
      : { name: 'INTERNAL_SERVER_ERROR', message: 'error', debug_id: 'dbg-1' },
  );

const NOW = new Date('2026-11-12T10:00:00.000Z');
const ORDER_ID = 'PAYPAL-ORD-1';

const setupRequest: MandateSetupRequest = {
  mandateRef: 'MNDT0000000001',
  orderId: 'SUB-0001-INIT',
  amount: 19.9,
  currency: 'EUR',
  description: 'Monthly plan',
  returnUrl: 'https://shop.test/checkout/paypal/mandate/callback',
  cancelUrl: 'https://shop.test/checkout/paypal/mandate/callback?cancel=1',
  notifyUrl: 'https://shop.test/hooks/paypal',
};

const pending: MandatePendingState = {
  provider: 'paypal',
  mandateRef: 'MNDT0000000001',
  orderId: 'SUB-0001-INIT',
  amount: 19.9,
  currency: 'EUR',
  providerRef: ORDER_ID,
  createdAt: '2026-11-12T09:00:00.000Z',
};

const mandate: Mandate = {
  provider: 'paypal',
  mandateRef: 'MNDT0000000001',
  providerMandateId: 'vt_1',
  status: 'active',
  createdAt: '2026-11-12T10:00:00.000Z',
  providerData: { customerId: 'cus_1' },
};

function purchaseUnit(overrides: Record<string, unknown> = {}) {
  return {
    referenceId: 'SUB-0001-INIT',
    invoiceId: 'SUB-0001-INIT',
    customId: 'MNDT0000000001',
    amount: { currencyCode: 'EUR', value: '19.90' },
    ...overrides,
  };
}

function approvedOrder(puOverrides: Record<string, unknown> = {}, status = 'APPROVED') {
  return { id: ORDER_ID, status, purchaseUnits: [purchaseUnit(puOverrides)] };
}

function completedOrder(vaultStatus = 'VAULTED', captureStatus = 'COMPLETED', captureValue = '19.90') {
  return {
    id: ORDER_ID,
    status: 'COMPLETED',
    purchaseUnits: [
      purchaseUnit({
        payments: {
          captures: [{ id: 'CAP-1', status: captureStatus, amount: { currencyCode: 'EUR', value: captureValue } }],
        },
      }),
    ],
    paymentSource: {
      paypal: {
        emailAddress: 'payer@example.com',
        attributes: { vault: { id: 'vt_1', status: vaultStatus, customer: { id: 'cus_1' } } },
      },
    },
  };
}

function chargeOrder(orderStatus: string, captureStatus?: string) {
  return {
    id: 'PAYPAL-ORD-2',
    status: orderStatus,
    purchaseUnits: [
      {
        invoiceId: 'SUB-0001-2026-12',
        customId: 'MNDT0000000001',
        amount: { currencyCode: 'EUR', value: '19.90' },
        ...(captureStatus
          ? {
              payments: {
                captures: [{ id: 'CAP-2', status: captureStatus, amount: { currencyCode: 'EUR', value: '19.90' } }],
              },
            }
          : {}),
      },
    ],
  };
}

const charge = { chargeRef: 'SUB-0001-2026-12', amount: 19.9, currency: 'EUR', description: 'Monthly plan 2026-12' };

describe('PayPalProvider mandates (Vault)', () => {
  let provider: PayPalProvider;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    provider = new PayPalProvider({ clientId: 'id', clientSecret: 'secret', environment: 'sandbox' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('implements IMandateProvider', () => {
    expect(isMandateProvider(provider)).toBe(true);
  });

  describe('createMandate', () => {
    beforeEach(() => {
      sdk.createOrder.mockResolvedValue({
        result: {
          id: ORDER_ID,
          status: 'PAYER_ACTION_REQUIRED',
          links: [
            { rel: 'self', href: `https://api.sandbox.paypal.com/v2/checkout/orders/${ORDER_ID}` },
            { rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}` },
          ],
        },
      });
    });

    it('creates one vault-with-purchase order (criterion 1)', async () => {
      const start = await provider.createMandate(setupRequest);

      expect(sdk.createOrder).toHaveBeenCalledTimes(1);
      const arg = sdk.createOrder.mock.calls[0][0];
      expect(arg.body.paymentSource.paypal.attributes.vault).toEqual({
        storeInVault: 'ON_SUCCESS',
        usageType: 'MERCHANT',
        customerType: 'CONSUMER',
        usagePattern: 'SUBSCRIPTION_PREPAID',
        description: 'Monthly plan',
        permitMultiplePaymentTokens: false,
      });
      expect(arg.body.intent).toBe('CAPTURE');
      expect(arg.body.purchaseUnits[0].invoiceId).toBe('SUB-0001-INIT');
      expect(arg.body.purchaseUnits[0].referenceId).toBe('SUB-0001-INIT');
      expect(arg.body.purchaseUnits[0].customId).toBe('MNDT0000000001');
      expect(arg.body.purchaseUnits[0].amount.value).toBe('19.90');
      expect(arg.body.purchaseUnits[0].amount.currencyCode).toBe('EUR');
      expect(arg.paypalRequestId).toBe('setup-SUB-0001-INIT');
      expect(arg.prefer).toBe('return=representation');
      const ctx = arg.body.paymentSource.paypal.experienceContext;
      expect(ctx.returnUrl).toContain('mandate_ref=MNDT0000000001');
      expect(ctx.cancelUrl).toBe(
        'https://shop.test/checkout/paypal/mandate/callback?cancel=1&mandate_ref=MNDT0000000001',
      );
      expect(ctx.shippingPreference).toBe('NO_SHIPPING');
      expect(ctx.userAction).toBe('PAY_NOW');

      expect(start.success).toBe(true);
      expect(start.pending?.providerRef).toBe(ORDER_ID);
      expect(start.approvalUrl).toBe(`https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`);
      expect(start.pending).toEqual({
        provider: 'paypal',
        mandateRef: 'MNDT0000000001',
        orderId: 'SUB-0001-INIT',
        amount: 19.9,
        currency: 'EUR',
        providerRef: ORDER_ID,
        createdAt: NOW.toISOString(),
      });
      // notifyUrl is ignored (no PayPal webhooks)
      expect(JSON.stringify(arg)).not.toContain('hooks/paypal');
    });

    it('uses config.customerType', async () => {
      const business = new PayPalProvider({ clientId: 'id', clientSecret: 'secret', customerType: 'BUSINESS' });
      await business.createMandate(setupRequest);
      expect(sdk.createOrder.mock.calls[0][0].body.paymentSource.paypal.attributes.vault.customerType).toBe('BUSINESS');
    });

    it('falls back to the approve link', async () => {
      sdk.createOrder.mockResolvedValueOnce({
        result: { id: ORDER_ID, status: 'CREATED', links: [{ rel: 'approve', href: 'https://paypal.test/approve' }] },
      });
      const start = await provider.createMandate(setupRequest);
      expect(start.approvalUrl).toBe('https://paypal.test/approve');
    });

    it('returns success: false on an API error without the SDK request in raw', async () => {
      sdk.createOrder.mockRejectedValueOnce(apiError(422, 'PAYEE_NOT_ENABLED_FOR_VAULTING'));
      const start = await provider.createMandate(setupRequest);
      expect(start.success).toBe(false);
      expect(start.pending).toBeUndefined();
      expect(JSON.stringify(start)).not.toContain('SECRET-TOKEN');
    });
  });

  describe('confirmMandate', () => {
    function happyPathMocks() {
      sdk.getOrder.mockResolvedValueOnce({ result: approvedOrder() });
      sdk.captureOrder.mockResolvedValueOnce({ result: completedOrder() });
    }

    async function happyPathResult() {
      happyPathMocks();
      const out = await provider.confirmMandate(pending, { query: { token: ORDER_ID, PayerID: 'P1' } });
      vi.clearAllMocks();
      return out;
    }

    it('happy path: reads, captures, vaults (criterion 2)', async () => {
      happyPathMocks();
      const out = await provider.confirmMandate(pending, { query: { token: ORDER_ID, PayerID: 'P1' } });

      expect(out.success).toBe(true);
      expect(out.verified).toBe(true);
      expect(out.terminal).toBe(true);
      expect(out.mandate?.providerMandateId).toBe('vt_1');
      expect(out.mandate?.providerData?.customerId).toBe('cus_1');
      expect(out.mandate).toEqual({
        provider: 'paypal',
        mandateRef: 'MNDT0000000001',
        providerMandateId: 'vt_1',
        status: 'active',
        createdAt: NOW.toISOString(),
        providerData: { customerId: 'cus_1' },
        unverified: { payerEmail: 'payer@example.com' },
      });
      expect(out.firstCharge.status).toBe('succeeded');
      expect(out.firstCharge.verified).toBe(true);
      expect(out.firstCharge.chargeRef).toBe('SUB-0001-INIT');
      expect(out.firstCharge.providerPaymentId).toBe(ORDER_ID);
      expect(out.firstCharge.amount).toBe(19.9);
      expect(out.firstCharge.currency).toBe('EUR');

      expect(sdk.getOrder).toHaveBeenCalledTimes(1);
      expect(sdk.getOrder).toHaveBeenCalledWith({ id: ORDER_ID });
      expect(sdk.captureOrder).toHaveBeenCalledTimes(1);
      expect(sdk.getOrder.mock.invocationCallOrder[0]).toBeLessThan(sdk.captureOrder.mock.invocationCallOrder[0]);
      expect(sdk.captureOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          id: pending.providerRef,
          paypalRequestId: 'capture-SUB-0001-INIT',
          prefer: 'return=representation',
        }),
      );
    });

    it('passes the configurator normalization as a terminal success', async () => {
      happyPathMocks();
      const checkout = new CheckoutConfigurator();
      checkout.registerProvider(provider);
      const out = await checkout.confirmMandate('paypal', pending, { query: { token: ORDER_ID } });
      expect(out.success).toBe(true);
      expect(out.terminal).toBe(true);
      expect(out.firstCharge.status).toBe('succeeded');
      expect(out.mandate?.providerMandateId).toBe('vt_1');
    });

    it('(a) a token for another order is refused without any API call', async () => {
      const out = await provider.confirmMandate(pending, { query: { token: 'OTHER' } });
      expect(out.success).toBe(false);
      expect(out.verified).toBe(false);
      expect(out.terminal).toBe(false);
      expect(out.error).toBe('Outcome does not match the pending setup');
      expect(out.firstCharge.chargeRef).toBe('SUB-0001-INIT');
      expect(sdk.getOrder).not.toHaveBeenCalled();
      expect(sdk.captureOrder).not.toHaveBeenCalled();
    });

    it('(b) an already COMPLETED order is not captured again and equals the happy path', async () => {
      const happy = await happyPathResult();
      sdk.getOrder.mockResolvedValueOnce({ result: completedOrder() });
      const out = await provider.confirmMandate(pending, {});
      expect(sdk.captureOrder).not.toHaveBeenCalled();
      expect(out).toEqual(happy);
    });

    it('(c) ORDER_ALREADY_CAPTURED re-reads the order and equals the happy path', async () => {
      const happy = await happyPathResult();
      sdk.getOrder
        .mockResolvedValueOnce({ result: approvedOrder() })
        .mockResolvedValueOnce({ result: completedOrder() });
      sdk.captureOrder.mockRejectedValueOnce(apiError(422, 'ORDER_ALREADY_CAPTURED'));
      const out = await provider.confirmMandate(pending, { query: { token: ORDER_ID } });
      expect(sdk.getOrder).toHaveBeenCalledTimes(2);
      expect(out).toEqual(happy);
    });

    it('(d) vault APPROVED after capture: MANDATE_NOT_VAULTED with the succeeded first charge', async () => {
      sdk.getOrder.mockResolvedValueOnce({ result: approvedOrder() });
      sdk.captureOrder.mockResolvedValueOnce({ result: completedOrder('APPROVED') });
      const out = await provider.confirmMandate(pending, {});
      expect(out.success).toBe(false);
      expect(out.verified).toBe(true);
      expect(out.terminal).toBe(true);
      expect(out.error).toBe('MANDATE_NOT_VAULTED');
      expect(out.mandate).toBeUndefined();
      expect(out.firstCharge.status).toBe('succeeded');
    });

    it('(e) an order amount of 9.90 is a terminal failure and is never captured', async () => {
      sdk.getOrder.mockResolvedValueOnce({
        result: approvedOrder({ amount: { currencyCode: 'EUR', value: '9.90' } }),
      });
      const out = await provider.confirmMandate(pending, {});
      expect(out.success).toBe(false);
      expect(out.verified).toBe(true);
      expect(out.terminal).toBe(true);
      expect(out.firstCharge.status).toBe('failed');
      expect(out.error).toBe('Order does not match the pending setup');
      expect(sdk.captureOrder).not.toHaveBeenCalled();
    });

    it('(f) a customId of another mandate is a terminal failure and is never captured', async () => {
      sdk.getOrder.mockResolvedValueOnce({ result: approvedOrder({ customId: 'MNDT9999999999' }) });
      const out = await provider.confirmMandate(pending, {});
      expect(out.success).toBe(false);
      expect(out.verified).toBe(true);
      expect(out.terminal).toBe(true);
      expect(out.firstCharge.status).toBe('failed');
      expect(out.error).toBe('Order does not match the pending setup');
      expect(sdk.captureOrder).not.toHaveBeenCalled();
    });

    it('an invoiceId or currency of another order is a terminal failure and is never captured', async () => {
      sdk.getOrder.mockResolvedValueOnce({ result: approvedOrder({ invoiceId: 'SUB-0002-INIT' }) });
      expect((await provider.confirmMandate(pending, {})).firstCharge.status).toBe('failed');
      sdk.getOrder.mockResolvedValueOnce({ result: approvedOrder({ amount: { currencyCode: 'USD', value: '19.90' } }) });
      expect((await provider.confirmMandate(pending, {})).terminal).toBe(true);
      expect(sdk.captureOrder).not.toHaveBeenCalled();
    });

    it('(g) PAYER_ACTION_REQUIRED is verified, non-terminal, never captured', async () => {
      sdk.getOrder.mockResolvedValueOnce({ result: approvedOrder({}, 'PAYER_ACTION_REQUIRED') });
      const out = await provider.confirmMandate(pending, {});
      expect(out.success).toBe(false);
      expect(out.verified).toBe(true);
      expect(out.terminal).toBe(false);
      expect(out.firstCharge).toEqual({
        status: 'unknown',
        verified: true,
        chargeRef: 'SUB-0001-INIT',
        error: 'ORDER_NOT_APPROVED',
      });
      expect(sdk.captureOrder).not.toHaveBeenCalled();
    });

    it.each(['CREATED', 'SAVED'])('%s is verified and non-terminal', async (status) => {
      sdk.getOrder.mockResolvedValueOnce({ result: approvedOrder({}, status) });
      const out = await provider.confirmMandate(pending, {});
      expect(out.terminal).toBe(false);
      expect(out.firstCharge.error).toBe('ORDER_NOT_APPROVED');
      expect(sdk.captureOrder).not.toHaveBeenCalled();
    });

    it('VOIDED is a terminal failure with a failed first charge', async () => {
      sdk.getOrder.mockResolvedValueOnce({ result: approvedOrder({}, 'VOIDED') });
      const out = await provider.confirmMandate(pending, {});
      expect(out.success).toBe(false);
      expect(out.verified).toBe(true);
      expect(out.terminal).toBe(true);
      expect(out.firstCharge.status).toBe('failed');
      expect(sdk.captureOrder).not.toHaveBeenCalled();
    });

    it('(h) a network error on getOrder is non-terminal with an unknown first charge', async () => {
      sdk.getOrder.mockRejectedValueOnce(new Error('socket hang up'));
      const out = await provider.confirmMandate(pending, {});
      expect(out.success).toBe(false);
      expect(out.terminal).toBe(false);
      expect(out.firstCharge.status).toBe('unknown');
      expect(sdk.captureOrder).not.toHaveBeenCalled();
    });

    it('(i) ApiError 401 on getOrder is non-terminal', async () => {
      sdk.getOrder.mockRejectedValueOnce(apiError(401));
      const out = await provider.confirmMandate(pending, {});
      expect(out.terminal).toBe(false);
      expect(out.firstCharge.status).toBe('unknown');
      expect(JSON.stringify(out)).not.toContain('SECRET-TOKEN');
    });

    it.each([403, 429, 500, 503])('ApiError %i on getOrder is non-terminal', async (status) => {
      sdk.getOrder.mockRejectedValueOnce(apiError(status));
      const out = await provider.confirmMandate(pending, {});
      expect(out.terminal).toBe(false);
      expect(out.firstCharge.status).toBe('unknown');
    });

    it('a capture error other than ORDER_ALREADY_CAPTURED is non-terminal and unknown', async () => {
      sdk.getOrder.mockResolvedValueOnce({ result: approvedOrder() });
      sdk.captureOrder.mockRejectedValueOnce(apiError(500));
      const out = await provider.confirmMandate(pending, {});
      expect(out.terminal).toBe(false);
      expect(out.firstCharge.status).toBe('unknown');
      expect(sdk.getOrder).toHaveBeenCalledTimes(1);

      sdk.getOrder.mockResolvedValueOnce({ result: approvedOrder() });
      sdk.captureOrder.mockRejectedValueOnce(new Error('ETIMEDOUT'));
      const out2 = await provider.confirmMandate(pending, {});
      expect(out2.terminal).toBe(false);
      expect(out2.firstCharge.status).toBe('unknown');
    });

    it('maps the first capture: PENDING unknown, DECLINED failed, other amount unknown', async () => {
      sdk.getOrder.mockResolvedValueOnce({ result: completedOrder('VAULTED', 'PENDING') });
      const pendingCapture = await provider.confirmMandate(pending, {});
      expect(pendingCapture.success).toBe(true);
      expect(pendingCapture.terminal).toBe(true);
      expect(pendingCapture.firstCharge.status).toBe('unknown');

      sdk.getOrder.mockResolvedValueOnce({ result: completedOrder('VAULTED', 'DECLINED') });
      const declined = await provider.confirmMandate(pending, {});
      expect(declined.firstCharge.status).toBe('failed');
      expect(declined.firstCharge.verified).toBe(true);

      sdk.getOrder.mockResolvedValueOnce({ result: completedOrder('VAULTED', 'COMPLETED', '9.90') });
      const other = await provider.confirmMandate(pending, {});
      expect(other.firstCharge.status).toBe('unknown');
      expect(other.firstCharge.error).toBe('Captured amount does not match');
      // Since 2.2.0 (#43): the stable code, and what was captured, so that the order can be refunded
      expect(other.firstCharge).toEqual({
        status: 'unknown',
        verified: true,
        chargeRef: 'SUB-0001-INIT',
        errorCode: 'AMOUNT_MISMATCH',
        error: 'Captured amount does not match',
        providerPaymentId: 'PAYPAL-ORD-1',
        amount: 9.9,
        currency: 'EUR',
      });
      // Still a terminal success with the vaulted mandate, as in 2.1.0
      expect(other.success).toBe(true);
      expect(other.terminal).toBe(true);
      expect(other.mandate?.providerMandateId).toBe('vt_1');
    });

    it('a captured amount mismatch keeps its fields through the configurator, and charge.unknown has data.errorCode (#43)', async () => {
      sdk.getOrder.mockResolvedValueOnce({ result: completedOrder('VAULTED', 'COMPLETED', '9.90') });
      const checkout = new CheckoutConfigurator();
      checkout.registerProvider(provider);
      const events: Array<{ event: string; payload: any }> = [];
      for (const event of ['mandate.created', 'mandate.setup_failed', 'charge.succeeded', 'charge.unknown'] as const) {
        checkout.events.on(event, (payload: unknown) => {
          events.push({ event, payload });
        });
      }
      const out = await checkout.confirmMandate('paypal', pending, {});
      expect(out.success).toBe(true);
      expect(out.terminal).toBe(true);
      expect(out.mandate?.providerMandateId).toBe('vt_1');
      expect(out.firstCharge).toMatchObject({
        status: 'unknown',
        verified: true,
        chargeRef: 'SUB-0001-INIT',
        errorCode: 'AMOUNT_MISMATCH',
        error: 'Captured amount does not match',
        providerPaymentId: 'PAYPAL-ORD-1',
        amount: 9.9,
        currency: 'EUR',
      });
      expect(events.map((e) => e.event)).toEqual(['mandate.created', 'charge.unknown']);
      const unknown = events[1].payload;
      expect(unknown.data.errorCode).toBe('AMOUNT_MISMATCH');
      expect(unknown.data).toMatchObject({ amount: 9.9, currency: 'EUR' });
      // The order id is the refundable id of the captured money: it is no longer scrubbed from the events
      expect(unknown.paymentId).toBe('PAYPAL-ORD-1');
      expect(JSON.stringify(events)).not.toContain('vt_1');
    });

    it('a COMPLETED capture without an amount is AMOUNT_MISMATCH, never a throw (#43)', async () => {
      const order: any = completedOrder('VAULTED', 'COMPLETED');
      delete order.purchaseUnits[0].payments.captures[0].amount;
      sdk.getOrder.mockResolvedValueOnce({ result: order });
      const out = await provider.confirmMandate(pending, {});
      expect(out.success).toBe(true);
      expect(out.firstCharge).toEqual({
        status: 'unknown',
        verified: true,
        chargeRef: 'SUB-0001-INIT',
        errorCode: 'AMOUNT_MISMATCH',
        error: 'Captured amount does not match',
        providerPaymentId: 'PAYPAL-ORD-1',
      });
    });

    it('MANDATE_NOT_VAULTED never emits the vault token id (outcome and mandate.setup_failed)', async () => {
      const order: any = completedOrder('APPROVED');
      order.paymentSource.paypal.attributes.vault.id = 'vt_SECRET';
      order.paymentSource.paypal.attributes.vault.links = [
        { rel: 'self', href: 'https://api-m.sandbox.paypal.com/v3/vault/payment-tokens/vt_SECRET' },
      ];
      sdk.getOrder.mockResolvedValueOnce({ result: approvedOrder() });
      sdk.captureOrder.mockResolvedValueOnce({ result: order });
      const checkout = new CheckoutConfigurator();
      checkout.registerProvider(provider);
      const events: Array<{ event: string; payload: unknown }> = [];
      for (const event of ['mandate.setup_failed', 'mandate.created', 'charge.succeeded'] as const) {
        checkout.events.on(event, (payload: unknown) => {
          events.push({ event, payload });
        });
      }
      const out = await checkout.confirmMandate('paypal', pending, {});
      expect(out.error).toBe('MANDATE_NOT_VAULTED');
      expect(out.terminal).toBe(true);
      expect(events.map((e) => e.event)).toEqual(['mandate.setup_failed', 'charge.succeeded']);
      expect(JSON.stringify(events)).not.toContain('vt_SECRET');
      expect(JSON.stringify(out)).not.toContain('vt_SECRET');
      expect((out.raw as any).paymentSource.paypal.attributes.vault.id).toBe('[redacted]');
      expect((out.raw as any).paymentSource.paypal.attributes.vault.status).toBe('APPROVED');
      // The SDK result is not mutated
      expect(order.paymentSource.paypal.attributes.vault.id).toBe('vt_SECRET');
    });

    it('ORDER_NOT_MATCHING and VOIDED never emit a vault token id', async () => {
      const vault = { attributes: { vault: { id: 'vt_SECRET', status: 'VAULTED' } } };
      const checkout = new CheckoutConfigurator();
      checkout.registerProvider(provider);
      const events: unknown[] = [];
      checkout.events.on('mandate.setup_failed', (payload: unknown) => {
        events.push(payload);
      });
      sdk.getOrder.mockResolvedValueOnce({
        result: { ...approvedOrder({ customId: 'OTHER-MANDATE' }), paymentSource: { paypal: vault } },
      });
      const notMatching = await checkout.confirmMandate('paypal', pending, {});
      expect(notMatching.error).toBe('Order does not match the pending setup');
      sdk.getOrder.mockResolvedValueOnce({ result: { ...approvedOrder({}, 'VOIDED'), paymentSource: { paypal: vault } } });
      const voided = await checkout.confirmMandate('paypal', pending, {});
      expect(voided.error).toBe('ORDER_VOIDED');
      expect(events).toHaveLength(2);
      expect(JSON.stringify(events)).not.toContain('vt_SECRET');
      expect(JSON.stringify([notMatching, voided])).not.toContain('vt_SECRET');
    });

    it('a missing vault is MANDATE_NOT_VAULTED', async () => {
      const order = completedOrder();
      delete (order.paymentSource.paypal.attributes as any).vault;
      sdk.getOrder.mockResolvedValueOnce({ result: order });
      const out = await provider.confirmMandate(pending, {});
      expect(out.success).toBe(false);
      expect(out.terminal).toBe(true);
      expect(out.error).toBe('MANDATE_NOT_VAULTED');
      expect(out.firstCharge.status).toBe('succeeded');
    });
  });

  describe('chargeMandate (criterion 4)', () => {
    it('creates a merchant-initiated order on the vault id', async () => {
      sdk.createOrder.mockResolvedValueOnce({ result: chargeOrder('COMPLETED', 'COMPLETED') });
      const result = await provider.chargeMandate(mandate, charge);

      expect(sdk.createOrder).toHaveBeenCalledTimes(1);
      const arg = sdk.createOrder.mock.calls[0][0];
      expect(arg.body.paymentSource.paypal).toEqual({
        vaultId: 'vt_1',
        storedCredential: { paymentInitiator: 'MERCHANT', usage: 'SUBSEQUENT', usagePattern: 'SUBSCRIPTION_PREPAID' },
      });
      expect(arg.paypalRequestId).toBe('SUB-0001-2026-12');
      expect(arg.body.purchaseUnits[0].invoiceId).toBe('SUB-0001-2026-12');
      expect(arg.body.purchaseUnits[0].referenceId).toBe('SUB-0001-2026-12');
      expect(arg.body.purchaseUnits[0].customId).toBe('MNDT0000000001');
      expect(arg.body.purchaseUnits[0].amount).toEqual({ currencyCode: 'EUR', value: '19.90' });
      expect(arg.prefer).toBe('return=representation');

      expect(result.status).toBe('succeeded');
      expect(result.verified).toBe(true);
      expect(result.chargeRef).toBe('SUB-0001-2026-12');
      expect(result.providerPaymentId).toBe('PAYPAL-ORD-2');
      expect(result.amount).toBe(19.9);
      expect(result.currency).toBe('EUR');
    });

    it('PAYER_ACTION_REQUIRED gives requires_action', async () => {
      sdk.createOrder.mockResolvedValueOnce({ result: chargeOrder('PAYER_ACTION_REQUIRED') });
      const result = await provider.chargeMandate(mandate, charge);
      expect(result.status).toBe('requires_action');
      expect(result.verified).toBe(true);
    });

    it('capture DECLINED gives failed', async () => {
      sdk.createOrder.mockResolvedValueOnce({ result: chargeOrder('COMPLETED', 'DECLINED') });
      const result = await provider.chargeMandate(mandate, charge);
      expect(result.status).toBe('failed');
      expect(result.verified).toBe(true);
    });

    it('capture FAILED gives failed, PENDING gives unknown, anything else unknown', async () => {
      sdk.createOrder.mockResolvedValueOnce({ result: chargeOrder('COMPLETED', 'FAILED') });
      expect((await provider.chargeMandate(mandate, charge)).status).toBe('failed');
      sdk.createOrder.mockResolvedValueOnce({ result: chargeOrder('COMPLETED', 'PENDING') });
      expect((await provider.chargeMandate(mandate, charge)).status).toBe('unknown');
      sdk.createOrder.mockResolvedValueOnce({ result: chargeOrder('CREATED') });
      expect((await provider.chargeMandate(mandate, charge)).status).toBe('unknown');
    });

    it('ApiError 422 DUPLICATE_INVOICE_ID gives unknown with that providerCode', async () => {
      sdk.createOrder.mockRejectedValueOnce(apiError(422, 'DUPLICATE_INVOICE_ID'));
      const result = await provider.chargeMandate(mandate, charge);
      expect(result.status).toBe('unknown');
      expect(result.providerCode).toBe('DUPLICATE_INVOICE_ID');
      expect(result.error).toBe('A charge with this chargeRef was already submitted; reconcile it in PayPal');
      expect(JSON.stringify(result)).not.toContain('SECRET-TOKEN');
    });

    it('ApiError 409 PREVIOUS_REQUEST_IN_PROGRESS gives unknown: the original may still charge', async () => {
      sdk.createOrder.mockRejectedValueOnce(
        new ApiError(409, {
          name: 'RESOURCE_CONFLICT',
          message: 'The server has detected a conflict while processing this request.',
          debug_id: 'dbg-1',
          details: [{ issue: 'PREVIOUS_REQUEST_IN_PROGRESS' }],
        }),
      );
      const result = await provider.chargeMandate(mandate, charge);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.providerCode).toBe('PREVIOUS_REQUEST_IN_PROGRESS');
      expect(result.error).toBe('PayPal charge outcome unknown (HTTP 409 PREVIOUS_REQUEST_IN_PROGRESS)');
      expect(JSON.stringify(result)).not.toContain('SECRET-TOKEN');
    });

    it('ApiError 422 PREVIOUS_REQUEST_IN_PROGRESS gives unknown', async () => {
      sdk.createOrder.mockRejectedValueOnce(apiError(422, 'PREVIOUS_REQUEST_IN_PROGRESS'));
      const result = await provider.chargeMandate(mandate, charge);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.providerCode).toBe('PREVIOUS_REQUEST_IN_PROGRESS');
    });

    it.each([409, 408])('ApiError %i without a body gives unknown', async (status) => {
      sdk.createOrder.mockRejectedValueOnce(new ApiError(status));
      const result = await provider.chargeMandate(mandate, charge);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.providerCode).toBe(String(status));
      expect(result.error).toBe(`PayPal charge outcome unknown (HTTP ${status})`);
    });

    it('through the configurator, a 409 is unknown and emits charge.unknown', async () => {
      sdk.createOrder.mockRejectedValueOnce(apiError(409, 'PREVIOUS_REQUEST_IN_PROGRESS'));
      const checkout = new CheckoutConfigurator();
      checkout.registerProvider(provider);
      const events: string[] = [];
      for (const event of ['charge.unknown', 'charge.failed'] as const) {
        checkout.events.on(event, () => {
          events.push(event);
        });
      }
      const result = await checkout.chargeMandate('paypal', mandate, charge);
      expect(result.status).toBe('unknown');
      expect(events).toEqual(['charge.unknown']);
    });

    it('ApiError 500 gives unknown', async () => {
      sdk.createOrder.mockRejectedValueOnce(apiError(500));
      const result = await provider.chargeMandate(mandate, charge);
      expect(result.status).toBe('unknown');
    });

    it('a network error gives unknown', async () => {
      sdk.createOrder.mockRejectedValueOnce(new Error('ECONNRESET'));
      const result = await provider.chargeMandate(mandate, charge);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
    });

    it('ApiError 422 PAYMENT_DENIED gives failed with that providerCode', async () => {
      sdk.createOrder.mockRejectedValueOnce(apiError(422, 'PAYMENT_DENIED'));
      const result = await provider.chargeMandate(mandate, charge);
      expect(result.status).toBe('failed');
      expect(result.verified).toBe(true);
      expect(result.providerCode).toBe('PAYMENT_DENIED');
    });

    it.each([401, 429, 403])('ApiError %i gives unknown', async (status) => {
      sdk.createOrder.mockRejectedValueOnce(apiError(status));
      const result = await provider.chargeMandate(mandate, charge);
      expect(result.status).toBe('unknown');
      expect(result.providerCode).toBe(String(status));
    });

    it("an API 401 (PayPal refused the access token) has errorCode 'PROVIDER_AUTH_FAILED'; 403 and 429 have none (#53)", async () => {
      sdk.createOrder.mockRejectedValueOnce(apiError(401));
      expect(await provider.chargeMandate(mandate, charge)).toEqual({
        status: 'unknown',
        verified: false,
        chargeRef: 'SUB-0001-2026-12',
        providerCode: '401',
        errorCode: 'PROVIDER_AUTH_FAILED',
        error: 'PayPal refused the request (HTTP 401)',
        raw: { name: 'INTERNAL_SERVER_ERROR', message: 'error', debug_id: 'dbg-1' },
      });
      for (const status of [403, 429]) {
        sdk.createOrder.mockRejectedValueOnce(apiError(status));
        const result = await provider.chargeMandate(mandate, charge);
        expect(result).toMatchObject({ status: 'unknown', verified: false, providerCode: String(status) });
        expect('errorCode' in result).toBe(false);
      }
    });

    it('an API 4xx that is not a token failure is still a verified refusal, without errorCode (#53)', async () => {
      sdk.createOrder.mockRejectedValueOnce(apiError(404));
      const result = await provider.chargeMandate(mandate, charge);
      expect(result).toMatchObject({
        status: 'failed',
        verified: true,
        error: 'PayPal refused the charge (HTTP 404 INTERNAL_SERVER_ERROR)',
      });
      expect('errorCode' in result).toBe(false);
    });

    it('reads the issue from a JSON body when result is not parsed', async () => {
      const err = new ApiError(422);
      err.body = JSON.stringify({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'DUPLICATE_INVOICE_ID' }] });
      sdk.createOrder.mockRejectedValueOnce(err);
      const result = await provider.chargeMandate(mandate, charge);
      expect(result.status).toBe('unknown');
      expect(result.providerCode).toBe('DUPLICATE_INVOICE_ID');
    });

    it('through the configurator, a COMPLETED charge is succeeded', async () => {
      sdk.createOrder.mockResolvedValueOnce({ result: chargeOrder('COMPLETED', 'COMPLETED') });
      const checkout = new CheckoutConfigurator();
      checkout.registerProvider(provider);
      const result = await checkout.chargeMandate('paypal', mandate, charge);
      expect(result.status).toBe('succeeded');
      expect(result.providerPaymentId).toBe('PAYPAL-ORD-2');
    });
  });

  describe('getMandate and revokeMandate (criterion 5)', () => {
    it('getMandate maps 200, 404 and 500', async () => {
      sdk.getPaymentToken.mockResolvedValueOnce({ statusCode: 200, result: { id: 'vt_1' } });
      expect(await provider.getMandate(mandate)).toEqual({ status: 'active', verified: true });
      expect(sdk.getPaymentToken).toHaveBeenCalledWith('vt_1');

      sdk.getPaymentToken.mockRejectedValueOnce(apiError(404, 'INVALID_RESOURCE_ID'));
      expect(await provider.getMandate(mandate)).toMatchObject({ status: 'revoked', verified: true });

      sdk.getPaymentToken.mockRejectedValueOnce(apiError(500));
      expect(await provider.getMandate(mandate)).toMatchObject({ status: 'unknown', verified: false });
    });

    it('revokeMandate maps 204, 404 and 500', async () => {
      sdk.deletePaymentToken.mockResolvedValueOnce({ statusCode: 204, result: undefined });
      expect((await provider.revokeMandate(mandate)).revokedAtProvider).toBe(true);
      expect(sdk.deletePaymentToken).toHaveBeenCalledWith('vt_1');

      sdk.deletePaymentToken.mockRejectedValueOnce(apiError(404, 'INVALID_RESOURCE_ID'));
      expect((await provider.revokeMandate(mandate)).revokedAtProvider).toBe(true);

      sdk.deletePaymentToken.mockRejectedValueOnce(apiError(500));
      const failed = await provider.revokeMandate(mandate);
      expect(failed.revokedAtProvider).toBe(false);
      expect(failed.error).toEqual(expect.any(String));
    });

    it('an API 404 from the vault (not a token failure) is still revoked, verified, without errorCode (#53)', async () => {
      sdk.getPaymentToken.mockRejectedValueOnce(apiError(404, 'INVALID_RESOURCE_ID'));
      expect(await provider.getMandate(mandate)).toEqual({ status: 'revoked', verified: true });
      sdk.deletePaymentToken.mockRejectedValueOnce(apiError(404, 'INVALID_RESOURCE_ID'));
      expect(await provider.revokeMandate(mandate)).toEqual({ revokedAtProvider: true });
    });

    it("an API 401 from the vault is unknown / not revoked, with errorCode 'PROVIDER_AUTH_FAILED' (#53)", async () => {
      sdk.getPaymentToken.mockRejectedValueOnce(apiError(401));
      expect(await provider.getMandate(mandate)).toEqual({
        status: 'unknown',
        verified: false,
        errorCode: 'PROVIDER_AUTH_FAILED',
        raw: { name: 'INTERNAL_SERVER_ERROR', message: 'error', debug_id: 'dbg-1' },
      });
      sdk.deletePaymentToken.mockRejectedValueOnce(apiError(401));
      expect(await provider.revokeMandate(mandate)).toEqual({
        revokedAtProvider: false,
        errorCode: 'PROVIDER_AUTH_FAILED',
        error: 'PayPal could not delete the vault token (HTTP 401 INTERNAL_SERVER_ERROR)',
        raw: { name: 'INTERNAL_SERVER_ERROR', message: 'error', debug_id: 'dbg-1' },
      });
      // 403 and 500 have no errorCode
      for (const status of [403, 500]) {
        sdk.getPaymentToken.mockRejectedValueOnce(apiError(status));
        expect('errorCode' in (await provider.getMandate(mandate))).toBe(false);
        sdk.deletePaymentToken.mockRejectedValueOnce(apiError(status));
        expect('errorCode' in (await provider.revokeMandate(mandate))).toBe(false);
      }
    });
  });

  describe('payment-method hints through the configurator (#46)', () => {
    /** `completedOrder()` without `paymentSource.paypal.emailAddress`. */
    function orderWithoutEmail() {
      const order = completedOrder();
      const { emailAddress: _emailAddress, ...paypal } = order.paymentSource.paypal;
      return { ...order, paymentSource: { paypal } };
    }

    /** Setup on a fresh configurator and provider: the order is read APPROVED, then captured as `captured`. */
    async function confirmThrough(config: CheckoutConfig, captured: unknown = completedOrder()) {
      sdk.getOrder.mockResolvedValueOnce({ result: approvedOrder() });
      sdk.captureOrder.mockResolvedValueOnce({ result: captured });
      const checkout = new CheckoutConfigurator(config);
      checkout.registerProvider(new PayPalProvider({ clientId: 'id', clientSecret: 'secret', environment: 'sandbox' }));
      return checkout.confirmMandate('paypal', pending, { query: { token: ORDER_ID, PayerID: 'P1' } });
    }

    it("a VAULTED order with emailAddress 'payer@example.com': hints { payerEmail }", async () => {
      const outcome = await confirmThrough({});
      expect(outcome).toMatchObject({ success: true, verified: true, terminal: true });
      expect(outcome.hints).toStrictEqual({ payerEmail: 'payer@example.com' });
      expect(outcome.mandate!.unverified).toStrictEqual({ payerEmail: 'payer@example.com' });

      const separate = await confirmThrough({ mandateHints: 'separate' });
      expect(separate.hints).toStrictEqual({ payerEmail: 'payer@example.com' });
      expect('unverified' in separate.mandate!).toBe(false);
      expect(JSON.stringify(separate.mandate)).not.toContain('payer@example.com');
      expect(separate.mandate).toStrictEqual({
        provider: 'paypal',
        mandateRef: 'MNDT0000000001',
        providerMandateId: 'vt_1',
        status: 'active',
        createdAt: NOW.toISOString(),
        providerData: { customerId: 'cus_1' },
      });
    });

    it.each([
      ['default', {}],
      ["'inline'", { mandateHints: 'inline' }],
      ["'separate'", { mandateHints: 'separate' }],
    ] as [string, CheckoutConfig][])(
      '%s: the same order without emailAddress gives no hints and no unverified key',
      async (_label, config) => {
        const outcome = await confirmThrough(config, orderWithoutEmail());
        expect(outcome).toMatchObject({ success: true, verified: true, terminal: true });
        expect(outcome.hints).toBeUndefined();
        expect('hints' in outcome).toBe(false);
        expect('unverified' in outcome.mandate!).toBe(false);
        expect(outcome.mandate!.providerData).toStrictEqual({ customerId: 'cus_1' });
      },
    );

    it('a separate-mode mandate, JSON round-tripped, charges, reads and revokes with the same vaultId and customId', async () => {
      const persisted = async (config: CheckoutConfig) =>
        JSON.parse(JSON.stringify((await confirmThrough(config)).mandate)) as Mandate;
      const separate = await persisted({ mandateHints: 'separate' });
      const legacy = await persisted({}); // what 2.1 returned and apps persisted: it still has unverified
      // What 2.1 persisted for a payer without an email ({ payerEmail: undefined } serializes as {})
      const legacyWithoutEmail: Mandate = { ...separate, unverified: {} };
      expect('unverified' in separate).toBe(false);
      expect(legacy.unverified).toStrictEqual({ payerEmail: 'payer@example.com' });

      /** The provider requests of chargeMandate, getMandate and revokeMandate on a fresh configurator. */
      const requests = async (persistedMandate: Mandate) => {
        sdk.createOrder.mockClear();
        sdk.getPaymentToken.mockClear();
        sdk.deletePaymentToken.mockClear();
        sdk.createOrder.mockResolvedValueOnce({ result: chargeOrder('COMPLETED', 'COMPLETED') });
        sdk.getPaymentToken.mockResolvedValueOnce({ statusCode: 200, result: { id: 'vt_1' } });
        sdk.deletePaymentToken.mockResolvedValueOnce({ statusCode: 204, result: undefined });
        const checkout = new CheckoutConfigurator();
        checkout.registerProvider(new PayPalProvider({ clientId: 'id', clientSecret: 'secret', environment: 'sandbox' }));
        const charged = await checkout.chargeMandate('paypal', persistedMandate, charge);
        expect(charged).toMatchObject({ status: 'succeeded', verified: true, providerPaymentId: 'PAYPAL-ORD-2' });
        expect(await checkout.getMandate('paypal', persistedMandate)).toStrictEqual({ status: 'active', verified: true });
        expect((await checkout.revokeMandate('paypal', persistedMandate)).revokedAtProvider).toBe(true);
        return {
          createOrder: sdk.createOrder.mock.calls,
          getPaymentToken: sdk.getPaymentToken.mock.calls,
          deletePaymentToken: sdk.deletePaymentToken.mock.calls,
        };
      };

      const sent = structuredClone(await requests(separate));
      expect(sent.createOrder).toHaveLength(1);
      expect(sent.createOrder[0][0].body.paymentSource.paypal.vaultId).toBe('vt_1');
      expect(sent.createOrder[0][0].body.purchaseUnits[0].customId).toBe('MNDT0000000001');
      expect(sent.createOrder[0][0].paypalRequestId).toBe('SUB-0001-2026-12');
      expect(sent.getPaymentToken).toEqual([['vt_1']]);
      expect(sent.deletePaymentToken).toEqual([['vt_1']]);
      expect(structuredClone(await requests(legacy))).toStrictEqual(sent);
      expect(structuredClone(await requests(legacyWithoutEmail))).toStrictEqual(sent);
    });
  });

  it('refundPayment still works on the order id of a mandate charge (criterion 6)', async () => {
    sdk.createOrder.mockResolvedValueOnce({ result: chargeOrder('COMPLETED', 'COMPLETED') });
    const result = await provider.chargeMandate(mandate, charge);
    sdk.getOrder.mockResolvedValueOnce({ result: chargeOrder('COMPLETED', 'COMPLETED') });
    sdk.refundCapturedPayment.mockResolvedValueOnce({ result: { id: 'REFUND-1', status: 'COMPLETED' } });

    const refund = await provider.refundPayment(result.providerPaymentId as string, 19.9);

    expect(sdk.getOrder).toHaveBeenCalledWith({ id: 'PAYPAL-ORD-2' });
    expect(sdk.refundCapturedPayment).toHaveBeenCalledWith({
      captureId: 'CAP-2',
      body: { amount: { value: '19.90', currencyCode: 'EUR' } },
    });
    expect(refund.success).toBe(true);
    expect(refund.paymentId).toBe('REFUND-1');
  });

  describe('refund idempotency key (#44)', () => {
    it('declares supportsRefundIdempotency', () => {
      expect(provider.supportsRefundIdempotency).toBe(true);
    });

    it("sends the key as paypalRequestId: { captureId: 'CAP-2', paypalRequestId, body }", async () => {
      sdk.getOrder.mockResolvedValueOnce({ result: chargeOrder('COMPLETED', 'COMPLETED') });
      sdk.refundCapturedPayment.mockResolvedValueOnce({ result: { id: 'REFUND-1', status: 'COMPLETED' } });

      const refund = await provider.refundPayment('PAYPAL-ORD-2', 19.9, { idempotencyKey: 'refund-SUB-0001-R1' });

      expect(sdk.refundCapturedPayment).toHaveBeenCalledTimes(1);
      expect(sdk.refundCapturedPayment).toHaveBeenCalledWith({
        captureId: 'CAP-2',
        paypalRequestId: 'refund-SUB-0001-R1',
        body: { amount: { value: '19.90', currencyCode: 'EUR' } },
      });
      expect(refund).toMatchObject({ success: true, verified: true, paymentId: 'REFUND-1', status: 'COMPLETED' });
    });

    it('through the configurator, the key reaches PayPal unchanged', async () => {
      sdk.getOrder.mockResolvedValueOnce({ result: chargeOrder('COMPLETED', 'COMPLETED') });
      sdk.refundCapturedPayment.mockResolvedValueOnce({ result: { id: 'REFUND-1', status: 'COMPLETED' } });
      const checkout = new CheckoutConfigurator();
      checkout.registerProvider(provider);

      const refund = await checkout.refundPayment('paypal', 'PAYPAL-ORD-2', 19.9, { idempotencyKey: 'refund-SUB-0001-R1' });

      expect(sdk.refundCapturedPayment).toHaveBeenCalledWith({
        captureId: 'CAP-2',
        paypalRequestId: 'refund-SUB-0001-R1',
        body: { amount: { value: '19.90', currencyCode: 'EUR' } },
      });
      expect(refund.success).toBe(true);
    });

    it('without options, or with options but no key, the call has no paypalRequestId key at all', async () => {
      for (const args of [[], [{}]] as const) {
        sdk.getOrder.mockResolvedValueOnce({ result: chargeOrder('COMPLETED', 'COMPLETED') });
        sdk.refundCapturedPayment.mockResolvedValueOnce({ result: { id: 'REFUND-1', status: 'COMPLETED' } });
        await provider.refundPayment('PAYPAL-ORD-2', 19.9, ...args);
        const arg = sdk.refundCapturedPayment.mock.calls.at(-1)?.[0];
        expect(Object.keys(arg).sort()).toEqual(['body', 'captureId']);
      }
    });

    it('called directly with a key that does not match REFUND_IDEMPOTENCY_KEY_PATTERN, refuses without any request', async () => {
      for (const idempotencyKey of ['', 'short', 'has space 1', 'x'.repeat(65), 123 as unknown as string]) {
        const refund = await provider.refundPayment('PAYPAL-ORD-2', 19.9, { idempotencyKey });
        expect(refund).toMatchObject({ success: false, status: 'REFUND_FAILED' });
        expect(refund.verified).not.toBe(true);
      }
      expect(sdk.getOrder).not.toHaveBeenCalled();
      expect(sdk.refundCapturedPayment).not.toHaveBeenCalled();
    });

    it('called directly with options of another shape (typed unknown, for 2.1 subclasses), refuses without any request', async () => {
      for (const options of [
        'duplicate',
        42,
        [],
        { idempotencyKy: 'refund-SUB-0001-R1' },
        { idempotencyKey: 'refund-SUB-0001-R1', reason: 'duplicate' },
      ]) {
        const refund = await provider.refundPayment('PAYPAL-ORD-2', 19.9, options);
        expect(refund).toEqual({
          success: false,
          paymentId: 'PAYPAL-ORD-2',
          status: 'REFUND_FAILED',
          error: 'Invalid refund options',
        });
      }
      expect(sdk.getOrder).not.toHaveBeenCalled();
      expect(sdk.refundCapturedPayment).not.toHaveBeenCalled();
    });

    it('called directly with null options, the call is exactly the 2.1 one', async () => {
      sdk.getOrder.mockResolvedValueOnce({ result: chargeOrder('COMPLETED', 'COMPLETED') });
      sdk.refundCapturedPayment.mockResolvedValueOnce({ result: { id: 'REFUND-1', status: 'COMPLETED' } });
      const refund = await provider.refundPayment('PAYPAL-ORD-2', 19.9, null);
      expect(sdk.refundCapturedPayment.mock.calls[0][0]).toEqual({
        captureId: 'CAP-2',
        body: { amount: { value: '19.90', currencyCode: 'EUR' } },
      });
      expect(refund.success).toBe(true);
    });
  });

  it('package.json declares @paypal/paypal-server-sdk ^2.5.0 (criterion 7)', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8'));
    expect(pkg.dependencies['@paypal/paypal-server-sdk']).toBe('^2.5.0');
  });
});
