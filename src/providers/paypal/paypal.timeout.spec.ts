import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PayPalProvider, PayPalProviderConfig } from './paypal.provider';
import { CheckoutConfigurator } from '../../checkout-configurator';
import { CheckoutEventName } from '../../events/checkout-event-bus';
import { Mandate, MandatePendingState, MandateSetupRequest } from '../../models/mandate.model';

// PayPalProvider timeoutMs (#45): the SDK Client gets `timeout` only for a valid value, and a call that
// times out fails like a network error, with no part of the SDK error (its config and request carry the
// bearer token) in a result or an event. A failed OAuth token request replaces the SDK client (the SDK
// would keep the failure for every later call): wiring here, end to end with the real SDK in
// paypal.oauth.spec.ts.

// Mock of PayPal Server SDK v2.5 that records the Client configurations, the Client instances and the
// client each controller is built with. Environment values are strings here so that the recorded
// configuration can be compared as a literal.
const sdk = vi.hoisted(() => ({
  clientConfigs: [] as unknown[],
  clients: [] as unknown[],
  controllers: [] as { kind: string; client: unknown }[],
  createOrder: vi.fn(),
  captureOrder: vi.fn(),
  getOrder: vi.fn(),
  refundCapturedPayment: vi.fn(),
  getCapturedPayment: vi.fn(),
  getPaymentToken: vi.fn(),
  deletePaymentToken: vi.fn(),
  searchTransactions: vi.fn(),
}));

vi.mock('@paypal/paypal-server-sdk', () => ({
  Environment: { Sandbox: 'Sandbox', Production: 'Production' },
  LogLevel: { Error: 'error' },
  Client: class {
    constructor(cfg: unknown) {
      sdk.clientConfigs.push(cfg);
      sdk.clients.push(this);
    }
  },
  OrdersController: class {
    createOrder = sdk.createOrder;
    captureOrder = sdk.captureOrder;
    getOrder = sdk.getOrder;
    constructor(client: unknown) {
      sdk.controllers.push({ kind: 'orders', client });
    }
  },
  PaymentsController: class {
    refundCapturedPayment = sdk.refundCapturedPayment;
    getCapturedPayment = sdk.getCapturedPayment;
    constructor(client: unknown) {
      sdk.controllers.push({ kind: 'payments', client });
    }
  },
  VaultController: class {
    getPaymentToken = sdk.getPaymentToken;
    deletePaymentToken = sdk.deletePaymentToken;
    constructor(client: unknown) {
      sdk.controllers.push({ kind: 'vault', client });
    }
  },
  TransactionSearchController: class {
    searchTransactions = sdk.searchTransactions;
    constructor(client: unknown) {
      sdk.controllers.push({ kind: 'search', client });
    }
  },
}));

/** The rejection of an SDK call that timed out (axios, SDK 2.5.0): its config and request carry the bearer token. */
const timeoutError = Object.assign(new Error('timeout of 30000ms exceeded'), {
  name: 'AxiosError',
  code: 'ECONNABORTED',
  config: { headers: { Authorization: 'Bearer SECRET-TOKEN' } },
  request: { headers: { authorization: 'Bearer SECRET-TOKEN' } },
});

/**
 * The Client options of 2.1.0, unchanged by `timeoutMs`, plus (since 2.2.0) the OAuth token provider that
 * replaces a client whose token request failed.
 */
const CLIENT_CONFIG = {
  clientCredentialsAuthCredentials: {
    oAuthClientId: 'id',
    oAuthClientSecret: 'secret',
    oAuthTokenProvider: expect.any(Function),
  },
  environment: 'Sandbox',
  logging: { logLevel: 'error' },
};

/** The SDK's `oAuthTokenProvider(lastToken, authManager)`, with the part of the auth manager it uses. */
type TokenProvider = (
  lastToken: unknown,
  authManager: { updateToken: (token?: unknown) => Promise<unknown> },
) => Promise<unknown>;

function tokenProviderOf(config: unknown): TokenProvider {
  return (config as { clientCredentialsAuthCredentials: { oAuthTokenProvider: TokenProvider } })
    .clientCredentialsAuthCredentials.oAuthTokenProvider;
}

/** The kinds of controller built with `client`, in order. */
function controllersOf(client: unknown): string[] {
  return sdk.controllers.filter((c) => c.client === client).map((c) => c.kind);
}

const ORDER_ID = 'PAYPAL-ORD-1';

const setupRequest: MandateSetupRequest = {
  mandateRef: 'MNDT0000000001',
  orderId: 'SUB-0001-INIT',
  amount: 19.9,
  currency: 'EUR',
  description: 'Monthly plan',
  returnUrl: 'https://shop.test/checkout/paypal/mandate/callback',
  cancelUrl: 'https://shop.test/checkout/paypal/mandate/callback?cancel=1',
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

const charge = { chargeRef: 'SUB-0001-2026-12', amount: 19.9, currency: 'EUR' };

const approvedOrder = {
  id: ORDER_ID,
  status: 'APPROVED',
  purchaseUnits: [
    {
      referenceId: 'SUB-0001-INIT',
      invoiceId: 'SUB-0001-INIT',
      customId: 'MNDT0000000001',
      amount: { currencyCode: 'EUR', value: '19.90' },
    },
  ],
};

const capturedOrder = {
  id: 'PAYPAL-ORD-2',
  status: 'COMPLETED',
  purchaseUnits: [
    {
      amount: { currencyCode: 'EUR', value: '19.90' },
      payments: { captures: [{ id: 'CAP-2', status: 'COMPLETED', amount: { currencyCode: 'EUR', value: '19.90' } }] },
    },
  ],
};

/** No part of the SDK error: neither the scheme nor the token. */
function expectNoSecret(value: unknown): void {
  const serialized = JSON.stringify(value) ?? '';
  expect(serialized).not.toContain('Bearer');
  expect(serialized).not.toContain('SECRET-TOKEN');
}

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

function newProvider(config: Partial<PayPalProviderConfig> = {}): PayPalProvider {
  return new PayPalProvider({ clientId: 'id', clientSecret: 'secret', ...config });
}

function configured(provider: PayPalProvider): { checkout: CheckoutConfigurator; events: { name: string; payload: unknown }[] } {
  const checkout = new CheckoutConfigurator().registerProvider(provider);
  const events: { name: string; payload: unknown }[] = [];
  for (const name of ALL_EVENTS) {
    checkout.events.on(name, (payload) => {
      events.push({ name, payload });
    });
  }
  return { checkout, events };
}

describe('PayPalProvider timeoutMs (#45)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sdk.clientConfigs.length = 0;
    sdk.clients.length = 0;
    sdk.controllers.length = 0;
  });

  describe('SDK Client configuration', () => {
    it('timeoutMs: 30000 constructs the Client with timeout: 30000 and the other options unchanged', () => {
      newProvider({ timeoutMs: 30000 });
      expect(sdk.clientConfigs).toHaveLength(1);
      expect(sdk.clientConfigs[0]).toEqual({ ...CLIENT_CONFIG, timeout: 30000 });
    });

    it("keeps environment 'live' and the credentials next to the timeout", () => {
      new PayPalProvider({ clientId: 'live-id', clientSecret: 'live-secret', environment: 'live', timeoutMs: 1500 });
      expect(sdk.clientConfigs[0]).toEqual({
        clientCredentialsAuthCredentials: {
          oAuthClientId: 'live-id',
          oAuthClientSecret: 'live-secret',
          oAuthTokenProvider: expect.any(Function),
        },
        environment: 'Production',
        logging: { logLevel: 'error' },
        timeout: 1500,
      });
    });

    it('without timeoutMs the Client has no timeout key, as in 2.1.0', () => {
      newProvider();
      expect(sdk.clientConfigs[0]).toEqual(CLIENT_CONFIG);
      expect(sdk.clientConfigs[0]).not.toHaveProperty('timeout');
    });

    it.each([
      ['undefined', undefined],
      ['0', 0],
      ['-1', -1],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ["'30000' (cast)", '30000' as unknown as number],
    ])('timeoutMs %s behaves as not set: no timeout key', (_label, timeoutMs) => {
      newProvider({ timeoutMs });
      expect(sdk.clientConfigs[0]).not.toHaveProperty('timeout');
      expect(sdk.clientConfigs[0]).toEqual(CLIENT_CONFIG);
    });
  });

  describe('a failed OAuth token request replaces the SDK client (the SDK would keep the failure)', () => {
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    it('the token provider is the SDK default: the token of authManager.updateToken(lastToken), and the same client', async () => {
      newProvider({ timeoutMs: 30000 });
      const lastToken = { accessToken: 'OLD', tokenType: 'Bearer', expiry: BigInt(0) };
      const token = { accessToken: 'A21AA-NEW', tokenType: 'Bearer' };
      const updateToken = vi.fn(async () => token);
      await expect(tokenProviderOf(sdk.clientConfigs[0])(lastToken, { updateToken })).resolves.toBe(token);
      expect(updateToken).toHaveBeenCalledTimes(1);
      expect(updateToken).toHaveBeenCalledWith(lastToken);
      expect(sdk.clients).toHaveLength(1);
    });

    it('rethrows the same error, so the calls waiting for that token fail as in 2.1, and builds a new client and controllers', async () => {
      const provider = newProvider({ timeoutMs: 30000 });
      sdk.searchTransactions.mockRejectedValue(timeoutError);
      await provider.getCharge('SUB-0001-2026-12', { since });
      const [first] = sdk.clients;
      expect(controllersOf(first)).toEqual(['orders', 'payments', 'vault', 'search']);

      const updateToken = vi.fn(async () => {
        throw timeoutError;
      });
      await expect(tokenProviderOf(sdk.clientConfigs[0])(undefined, { updateToken })).rejects.toBe(timeoutError);
      expect(sdk.clients).toHaveLength(2);
      // The same options, with a token provider of its own
      expect(sdk.clientConfigs[1]).toEqual({ ...CLIENT_CONFIG, timeout: 30000 });
      expect(tokenProviderOf(sdk.clientConfigs[1])).not.toBe(tokenProviderOf(sdk.clientConfigs[0]));
      const second = sdk.clients[1];
      expect(controllersOf(second)).toEqual(['orders', 'payments', 'vault']);

      // The Transaction Search controller too is built again, on the new client
      await provider.getCharge('SUB-0001-2026-12', { since });
      expect(controllersOf(second)).toEqual(['orders', 'payments', 'vault', 'search']);
      expect(controllersOf(first)).toEqual(['orders', 'payments', 'vault', 'search']);
    });

    it('only the current client is replaced: a late failure on a client already replaced builds nothing', async () => {
      newProvider();
      const failing = {
        updateToken: vi.fn(async () => {
          throw timeoutError;
        }),
      };
      const firstProvider = tokenProviderOf(sdk.clientConfigs[0]);
      await expect(firstProvider(undefined, failing)).rejects.toBe(timeoutError);
      expect(sdk.clients).toHaveLength(2);
      // A concurrent call of the first client whose token request fails later
      await expect(firstProvider(undefined, failing)).rejects.toBe(timeoutError);
      expect(sdk.clients).toHaveLength(2);
      // A failure on the current client replaces it again: without timeoutMs too
      await expect(tokenProviderOf(sdk.clientConfigs[1])(undefined, failing)).rejects.toBe(timeoutError);
      expect(sdk.clients).toHaveLength(3);
      expect(sdk.clientConfigs[2]).toEqual(CLIENT_CONFIG);
    });
  });

  describe('what the token provider rethrows is a token failure: never classified as an API answer (#53)', () => {
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    /** An SDK error of the token request answered `statusCode` (it carries the request with the Basic credentials). */
    function tokenError(statusCode: number): Error {
      // The SDK's OAuthProviderError (400, 401) has an empty message
      const message = statusCode === 400 || statusCode === 401 ? '' : `Response status code was not ok: ${statusCode}.`;
      return Object.assign(new Error(message), {
        name: 'ApiError',
        statusCode,
        body: JSON.stringify({ error: 'invalid_client', error_description: 'Client Authentication failed' }),
        request: { headers: { Authorization: 'Basic SECRET-TOKEN' } },
      });
    }

    /** Fails the current client's token request with `error`, as the SDK does: the provider marks it, then rethrows it. */
    async function failTokenRequest(error: unknown): Promise<void> {
      const clients = sdk.clients.length;
      const updateToken = vi.fn(async () => {
        throw error;
      });
      await expect(tokenProviderOf(sdk.clientConfigs[clients - 1])(undefined, { updateToken })).rejects.toBe(error);
      // The client was replaced (connect() ran): the mark must survive it
      expect(sdk.clients).toHaveLength(clients + 1);
    }

    it('a marked 404 from getCapturedPayment is an unknown lookup with errorCode, not a skipped record', async () => {
      const provider = newProvider({ timeoutMs: 30000 });
      const marked = tokenError(404);
      await failTokenRequest(marked);
      sdk.searchTransactions.mockResolvedValueOnce({
        result: { transactionDetails: [{ transactionInfo: { transactionId: 'CAP-1', invoiceId: 'SUB-0001-2026-12' } }] },
      });
      sdk.getCapturedPayment.mockRejectedValueOnce(marked);
      const result = await provider.getCharge('SUB-0001-2026-12', { since });
      expect(result).toEqual({
        status: 'unknown',
        verified: false,
        chargeRef: 'SUB-0001-2026-12',
        errorCode: 'PROVIDER_AUTH_UNAVAILABLE',
        error: 'PayPal capture could not be read (HTTP 404)',
      });
      expectNoSecret(result);

      // The same 404 not marked (an API answer: not a capture) is still skipped
      sdk.searchTransactions.mockResolvedValueOnce({
        result: { transactionDetails: [{ transactionInfo: { transactionId: 'CAP-1', invoiceId: 'SUB-0001-2026-12' } }] },
      });
      sdk.getCapturedPayment.mockRejectedValueOnce(tokenError(404));
      expect(await provider.getCharge('SUB-0001-2026-12', { since })).toEqual({
        status: 'unknown',
        verified: false,
        chargeRef: 'SUB-0001-2026-12',
        error: 'PayPal lists this invoice_id but no capture was found',
      });
    });

    it('a marked 404 is never revoked: getMandate unknown, revokeMandate false, both with errorCode', async () => {
      const provider = newProvider();
      const marked = tokenError(404);
      await failTokenRequest(marked);
      sdk.getPaymentToken.mockRejectedValueOnce(marked);
      expect(await provider.getMandate(mandate)).toEqual({
        status: 'unknown',
        verified: false,
        errorCode: 'PROVIDER_AUTH_UNAVAILABLE',
      });
      sdk.deletePaymentToken.mockRejectedValueOnce(marked);
      expect(await provider.revokeMandate(mandate)).toEqual({
        revokedAtProvider: false,
        errorCode: 'PROVIDER_AUTH_UNAVAILABLE',
        error: 'PayPal could not delete the vault token (HTTP 404)',
      });
    });

    it('a marked 400 is never a failed charge: unknown, merchant-side, with errorCode; charge.unknown carries it', async () => {
      const provider = newProvider();
      const marked = tokenError(400);
      await failTokenRequest(marked);
      sdk.createOrder.mockRejectedValueOnce(marked);
      const { checkout, events } = configured(provider);
      const result = await checkout.chargeMandate('paypal', mandate, charge);
      expect(result).toEqual({
        status: 'unknown',
        verified: false,
        chargeRef: 'SUB-0001-2026-12',
        providerCode: '400',
        errorCode: 'PROVIDER_AUTH_FAILED',
        error: 'PayPal refused the request (HTTP 400)',
      });
      expect(events.map((e) => e.name)).toEqual(['charge.unknown']);
      expect((events[0].payload as { data: { errorCode?: string } }).data.errorCode).toBe('PROVIDER_AUTH_FAILED');
      expectNoSecret(result);
      expectNoSecret(events);
    });

    it("a marked refusal of the refund call is 'REFUND_FAILED': nothing was sent", async () => {
      const provider = newProvider();
      sdk.getOrder.mockResolvedValueOnce({ result: capturedOrder });
      const marked = tokenError(401);
      await failTokenRequest(marked);
      sdk.refundCapturedPayment.mockRejectedValueOnce(marked);
      expect(await provider.refundPayment('PAYPAL-ORD-2', 5)).toEqual({
        success: false,
        paymentId: 'PAYPAL-ORD-2',
        status: 'REFUND_FAILED',
        errorCode: 'PROVIDER_AUTH_FAILED',
        error: 'PayPal authentication failed (HTTP 401)',
      });
    });

    it('a non-object rejection of the token request is wrapped in an Error, then marked', async () => {
      const provider = newProvider();
      const config = sdk.clientConfigs[0];
      let thrown: unknown;
      await tokenProviderOf(config)(undefined, {
        updateToken: async () => {
          throw 'token service down';
        },
      }).catch((err: unknown) => {
        thrown = err;
      });
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('PayPal access token unavailable');
      sdk.getOrder.mockRejectedValueOnce(thrown);
      expect(await provider.getPaymentDetails('PAYPAL-ORD-2')).toEqual({
        success: false,
        errorCode: 'PROVIDER_AUTH_UNAVAILABLE',
        error: 'PayPal access token unavailable',
      });
    });
  });

  describe('a call that times out fails like a network error, with no SDK error in results or events', () => {
    let provider: PayPalProvider;

    beforeEach(() => {
      provider = newProvider({ timeoutMs: 30000 });
    });

    it('chargeMandate (createOrder rejects) is unknown and unverified', async () => {
      sdk.createOrder.mockRejectedValueOnce(timeoutError);
      const result = await provider.chargeMandate(mandate, charge);
      expect(result).toMatchObject({ status: 'unknown', verified: false, chargeRef: 'SUB-0001-2026-12' });
      expectNoSecret(result);
    });

    it('through CheckoutConfigurator.chargeMandate it is unknown, never failed, and charge.unknown carries no secret', async () => {
      sdk.createOrder.mockRejectedValueOnce(timeoutError);
      const { checkout, events } = configured(provider);
      const result = await checkout.chargeMandate('paypal', mandate, charge);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(events.map((e) => e.name)).toEqual(['charge.unknown']);
      expectNoSecret(result);
      expectNoSecret(events);
    });

    it('confirmMandate with getOrder rejecting is non-terminal, unverified, with an unknown first charge', async () => {
      sdk.getOrder.mockRejectedValueOnce(timeoutError);
      const out = await provider.confirmMandate(pending, {});
      expect(out).toMatchObject({ success: false, terminal: false, verified: false });
      expect(out.firstCharge.status).toBe('unknown');
      expect(sdk.captureOrder).not.toHaveBeenCalled();
      expectNoSecret(out);
    });

    it('confirmMandate with getOrder APPROVED and captureOrder rejecting is non-terminal, unverified, with an unknown first charge', async () => {
      sdk.getOrder.mockResolvedValueOnce({ result: approvedOrder });
      sdk.captureOrder.mockRejectedValueOnce(timeoutError);
      const out = await provider.confirmMandate(pending, {});
      expect(out).toMatchObject({ success: false, terminal: false, verified: false });
      expect(out.firstCharge.status).toBe('unknown');
      expectNoSecret(out);
    });

    it('through CheckoutConfigurator.confirmMandate both stay non-terminal and emit nothing', async () => {
      const { checkout, events } = configured(provider);
      sdk.getOrder.mockRejectedValueOnce(timeoutError);
      const read = await checkout.confirmMandate('paypal', pending, {});
      sdk.getOrder.mockResolvedValueOnce({ result: approvedOrder });
      sdk.captureOrder.mockRejectedValueOnce(timeoutError);
      const captured = await checkout.confirmMandate('paypal', pending, {});
      for (const out of [read, captured]) {
        expect(out).toMatchObject({ success: false, terminal: false, verified: false });
        expect(out.firstCharge.status).toBe('unknown');
        expectNoSecret(out);
      }
      expect(events).toHaveLength(0);
    });

    it('getMandate is unknown', async () => {
      sdk.getPaymentToken.mockRejectedValueOnce(timeoutError);
      const result = await provider.getMandate(mandate);
      expect(result).toMatchObject({ status: 'unknown', verified: false });
      expectNoSecret(result);
    });

    it('revokeMandate is revokedAtProvider: false, and mandate.revoked carries no secret', async () => {
      sdk.deletePaymentToken.mockRejectedValueOnce(timeoutError);
      const direct = await provider.revokeMandate(mandate);
      expect(direct.revokedAtProvider).toBe(false);
      expectNoSecret(direct);

      sdk.deletePaymentToken.mockRejectedValueOnce(timeoutError);
      const { checkout, events } = configured(provider);
      const viaCheckout = await checkout.revokeMandate('paypal', mandate);
      expect(viaCheckout.revokedAtProvider).toBe(false);
      expect(events.map((e) => e.name)).toEqual(['mandate.revoked']);
      expectNoSecret(events);
    });

    it('createMandate is success: false without verified', async () => {
      sdk.createOrder.mockRejectedValueOnce(timeoutError);
      const result = await provider.createMandate(setupRequest);
      expect(result.success).toBe(false);
      expect((result as { verified?: unknown }).verified).not.toBe(true);
      expectNoSecret(result);
    });

    it('createPayment, executePayment and getPaymentDetails are success: false without verified', async () => {
      sdk.createOrder.mockRejectedValueOnce(timeoutError);
      sdk.captureOrder.mockRejectedValueOnce(timeoutError);
      sdk.getOrder.mockRejectedValueOnce(timeoutError);
      const results = [
        await provider.createPayment({
          amount: 19.9,
          currency: 'EUR',
          returnUrl: 'https://shop.test/ok',
          cancelUrl: 'https://shop.test/ko',
        }),
        await provider.executePayment(ORDER_ID),
        await provider.getPaymentDetails(ORDER_ID),
      ];
      for (const result of results) {
        expect(result.success).toBe(false);
        expect(result.verified).not.toBe(true);
        expectNoSecret(result);
      }
    });

    it('refundPayment is success: false without verified, whether the order read or the refund itself times out', async () => {
      sdk.getOrder.mockRejectedValueOnce(timeoutError);
      const read = await provider.refundPayment('PAYPAL-ORD-2', 19.9);
      sdk.getOrder.mockResolvedValueOnce({ result: capturedOrder });
      sdk.refundCapturedPayment.mockRejectedValueOnce(timeoutError);
      const refund = await provider.refundPayment('PAYPAL-ORD-2', 19.9, { idempotencyKey: 'refund-SUB-0001-R1' });
      for (const result of [read, refund]) {
        expect(result.success).toBe(false);
        expect(result.verified).not.toBe(true);
        expectNoSecret(result);
      }
      expect(sdk.refundCapturedPayment).toHaveBeenCalledTimes(1);
    });

    it('through the configurator, payment.failed and payment.refunded carry no secret', async () => {
      const { checkout, events } = configured(provider);
      sdk.captureOrder.mockRejectedValueOnce(timeoutError);
      await checkout.executePayment('paypal', ORDER_ID);
      sdk.getOrder.mockResolvedValueOnce({ result: capturedOrder });
      sdk.refundCapturedPayment.mockRejectedValueOnce(timeoutError);
      await checkout.refundPayment('paypal', 'PAYPAL-ORD-2', 19.9);
      expect(events.map((e) => e.name)).toEqual(['payment.failed', 'payment.refunded']);
      expectNoSecret(events);
    });

    it('getCharge (Transaction Search, #40) is unknown', async () => {
      sdk.searchTransactions.mockRejectedValueOnce(timeoutError);
      const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const result = await provider.getCharge('SUB-0001-2026-12', { since });
      expect(result).toMatchObject({ status: 'unknown', verified: false, chargeRef: 'SUB-0001-2026-12' });
      expectNoSecret(result);
    });
  });
});
