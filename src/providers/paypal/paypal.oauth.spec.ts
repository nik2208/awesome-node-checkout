import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PayPalProvider, PayPalProviderConfig } from './paypal.provider';
import { CheckoutConfigurator } from '../../checkout-configurator';
import type { CheckoutEventName, CheckoutEventPayload } from '../../events/checkout-event-bus';
import { Mandate, MandatePendingState, MandateSetupRequest } from '../../models/mandate.model';
import type { PaymentRequest } from '../../models/payment-request.model';
import type { ProviderErrorCode } from '../../models/payment-result.model';

// A failed OAuth token request (#45), with the real PayPal SDK 2.5.0: no mock. The SDK keeps the token
// request of a client and makes every later call of that client wait for it, so in 2.1 one failed token
// request (a timeout, a reset connection, an HTTP error) made every later call of the provider fail at once,
// with nothing sent, until the app built a new provider.
//
// Since 2.3.0 (#53) such a failure, and an API call answered 401, carry a stable `errorCode`, and a failed token
// request is never reported as PayPal's answer to the API call it never sent.
//
// A local fake PayPal answers instead of api-m.sandbox.paypal.com: axios sends every request, in clear text and
// with its absolute URL, to the proxy named by `https_proxy`, so nothing leaves the machine, and every test
// checks the requests the fake received.

type TokenStep = 'hang' | 'reset' | number;

const PROXY_ENV = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY'];

const CLIENT_ID = 'CLIENT-ID-0001';
const CLIENT_SECRET = 'CLIENT-SECRET-0001';
const ACCESS_TOKEN = 'A21AA-FAKE-ACCESS-TOKEN';

/** The body of every failed token request. */
const INVALID_CLIENT = { error: 'invalid_client', error_description: 'Client Authentication failed' };
/** The body of every API request when `fake.apiUnauthorized` is set. */
const AUTHENTICATION_FAILURE = {
  name: 'AUTHENTICATION_FAILURE',
  message: 'Authentication failed due to invalid authentication credentials or a missing Authorization header.',
};

const fake = {
  server: undefined as http.Server | undefined,
  /** Answers of the successive token requests; the last one repeats. */
  tokenPlan: [] as TokenStep[],
  tokenRequests: 0,
  /** Since 2.3.0 (#53): every API request (not the token request) answers 401 AUTHENTICATION_FAILURE. */
  apiUnauthorized: false,
  /** `METHOD /path` of every request received. */
  requests: [] as string[],
};

const capturedOrder = (id: string, invoiceId: string) => ({
  id,
  status: 'COMPLETED',
  purchase_units: [
    {
      reference_id: invoiceId,
      invoice_id: invoiceId,
      amount: { currency_code: 'EUR', value: '19.90' },
      payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '19.90' } }] },
    },
  ],
});

/**
 * `connection: close`: no connection is reused, so a test never gets a connection that an earlier one closed (a
 * request sent on it would fail without reaching the fake).
 */
function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify(body));
}

function answer(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'https://api-m.sandbox.paypal.com');
  fake.requests.push(`${req.method} ${url.pathname}`);
  if (req.method === 'POST' && url.pathname === '/v1/oauth2/token') {
    const step = fake.tokenPlan[Math.min(fake.tokenRequests++, fake.tokenPlan.length - 1)];
    if (step === 'hang') return; // accepted, never answered
    if (step === 'reset') {
      req.socket.destroy();
      return;
    }
    if (step === 200) {
      json(res, 200, { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 32400, scope: 'openid' });
      return;
    }
    json(res, step ?? 500, INVALID_CLIENT);
    return;
  }
  if (fake.apiUnauthorized) {
    json(res, 401, AUTHENTICATION_FAILURE);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/v2/checkout/orders/ORD-1') {
    json(res, 200, capturedOrder('ORD-1', 'SUB-0001-INIT'));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v2/checkout/orders') {
    json(res, 201, capturedOrder('ORD-2', 'SUB-0001-2026-12'));
    return;
  }
  json(res, 404, { name: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.' });
}

const mandate: Mandate = {
  provider: 'paypal',
  mandateRef: 'MNDT0000000001',
  providerMandateId: 'vt_1',
  status: 'active',
  createdAt: '2026-11-12T10:00:00.000Z',
  providerData: { customerId: 'cus_1' },
};

const charge = { chargeRef: 'SUB-0001-2026-12', amount: 19.9, currency: 'EUR' };

const paymentRequest: PaymentRequest = {
  amount: 19.9,
  currency: 'EUR',
  description: 'Order 1',
  returnUrl: 'https://shop.test/checkout/paypal/redirect',
  cancelUrl: 'https://shop.test/checkout/paypal/cancel',
};

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
  providerRef: 'ORD-1',
  createdAt: '2026-11-12T09:00:00.000Z',
};

const SINCE = '2026-11-01T00:00:00Z';

function newProvider(config: Partial<PayPalProviderConfig> = {}): PayPalProvider {
  return new PayPalProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, ...config });
}

/** No part of the token request (its Basic credentials) and no token in a result. */
function expectNoCredentials(value: unknown): void {
  const serialized = JSON.stringify(value) ?? '';
  expect(serialized).not.toContain('Basic');
  expect(serialized).not.toContain(CLIENT_SECRET);
  expect(serialized).not.toContain(Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'));
  expect(serialized).not.toContain(ACCESS_TOKEN);
}

const TOKEN = 'POST /v1/oauth2/token';
const READ = 'GET /v2/checkout/orders/ORD-1';
const CREATE_ORDER = 'POST /v2/checkout/orders';
const CAPTURE = 'POST /v2/checkout/orders/ORD-1/capture';
const READ_TOKEN = 'GET /v3/vault/payment-tokens/vt_1';
const DELETE_TOKEN = 'DELETE /v3/vault/payment-tokens/vt_1';
const SEARCH = 'GET /v1/reporting/transactions';

/** Every CheckoutEventName (the type has no runtime list). */
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

const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  const server = http.createServer(answer);
  fake.server = server;
  // On the wildcard address, like the supertest servers of the other spec files (which connect to 127.0.0.1): with
  // BSD socket semantics (macOS) a listener on 127.0.0.1:P shadows a wildcard listener that another process gets on
  // the same ephemeral port P, so a supertest request could reach this fake; two wildcard listeners never share one
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  for (const key of PROXY_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.https_proxy = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const key of PROXY_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  const server = fake.server;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

beforeEach(() => {
  fake.tokenPlan = [];
  fake.tokenRequests = 0;
  fake.apiUnauthorized = false;
  fake.requests.length = 0;
  // The SDK logs every request and response (logLevel 'error')
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  // Drops the token request left hanging, and the SDK's idle connections
  fake.server?.closeAllConnections();
});

describe('PayPalProvider after a failed OAuth token request (real SDK, #45)', () => {
  it('with timeoutMs, a token request that never answers fails the call waiting for it; the next call requests a new token', async () => {
    fake.tokenPlan = ['hang', 200];
    const provider = newProvider({ timeoutMs: 300 });

    const first = await provider.getPaymentDetails('ORD-1');
    // The 2.1 result of a network error: the message only, no verified; since 2.3.0 (#53) with its errorCode
    expect(first).toEqual({ success: false, errorCode: 'PROVIDER_AUTH_UNAVAILABLE', error: 'timeout of 300ms exceeded' });
    expectNoCredentials(first);
    expect(fake.requests).toEqual([TOKEN]);

    const second = await provider.getPaymentDetails('ORD-1');
    expect(second).toMatchObject({ success: true, verified: true, paymentId: 'ORD-1', status: 'COMPLETED', amount: 19.9 });
    expect('errorCode' in second).toBe(false);
    const third = await provider.getPaymentDetails('ORD-1');
    expect(third.success).toBe(true);
    // A new token on the second call, then kept as usual
    expect(fake.requests).toEqual([TOKEN, TOKEN, READ, READ]);
  });

  it('without timeoutMs, a token request whose connection is reset no longer disables the provider', async () => {
    fake.tokenPlan = ['reset', 200];
    const provider = newProvider();

    const first = await provider.getPaymentDetails('ORD-1');
    expect(first.success).toBe(false);
    expect(first.verified).toBeUndefined();
    expect(first.errorCode).toBe('PROVIDER_AUTH_UNAVAILABLE');
    expectNoCredentials(first);

    const second = await provider.getPaymentDetails('ORD-1');
    expect(second).toMatchObject({ success: true, verified: true, paymentId: 'ORD-1' });
    expect(fake.requests).toEqual([TOKEN, TOKEN, READ]);
  });

  it('a charge whose token request gets an HTTP error keeps its 2.1 result, and the next charge requests a new token', async () => {
    fake.tokenPlan = [401, 503, 200];
    const provider = newProvider({ timeoutMs: 5000 });

    const refused = await provider.chargeMandate(mandate, charge);
    expect(refused).toMatchObject({
      status: 'unknown',
      verified: false,
      chargeRef: 'SUB-0001-2026-12',
      providerCode: '401',
      error: 'PayPal refused the request (HTTP 401)',
      errorCode: 'PROVIDER_AUTH_FAILED',
    });
    const unavailable = await provider.chargeMandate(mandate, charge);
    expect(unavailable).toMatchObject({
      status: 'unknown',
      verified: false,
      chargeRef: 'SUB-0001-2026-12',
      error: 'PayPal charge outcome unknown (HTTP 503)',
      errorCode: 'PROVIDER_AUTH_UNAVAILABLE',
    });
    for (const result of [refused, unavailable]) expectNoCredentials(result);
    // Nothing but token requests so far: no order was created
    expect(fake.requests).toEqual([TOKEN, TOKEN]);

    const charged = await provider.chargeMandate(mandate, charge);
    expect(charged).toMatchObject({
      status: 'succeeded',
      verified: true,
      chargeRef: 'SUB-0001-2026-12',
      providerPaymentId: 'ORD-2',
      amount: 19.9,
      currency: 'EUR',
    });
    expect('errorCode' in charged).toBe(false);
    expect(fake.requests).toEqual([TOKEN, TOKEN, TOKEN, 'POST /v2/checkout/orders']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// #53: a failed token request (or an API 401) carries a stable errorCode and is never reported as PayPal's answer
// ---------------------------------------------------------------------------------------------------------------

interface Scenario {
  name: string;
  tokenPlan: TokenStep[];
  /** The token is issued, and every API request answers 401 AUTHENTICATION_FAILURE. */
  apiUnauthorized?: true;
  timeoutMs?: number;
  errorCode: ProviderErrorCode;
  /** `error` of createPayment, executePayment, handleRedirect, getPaymentDetails and refundPayment. */
  payment: string;
  /** `error` of createMandate. */
  setup: string;
  /** `error` of confirmMandate and of its first charge. */
  confirm: string;
  /** `providerCode` and `error` of chargeMandate. */
  charge: { providerCode?: string; error: string };
  /** `error` of revokeMandate. */
  revoke: string;
  /** `error` of getCharge. */
  lookup: string;
  /** `raw` of the mandate and lookup results: PayPal's error body, when the SDK parsed one, per controller. */
  raw: { orders?: unknown; vault?: unknown; search?: unknown };
}

const SCENARIOS: Scenario[] = [
  {
    name: 'token 400',
    tokenPlan: [400],
    errorCode: 'PROVIDER_AUTH_FAILED',
    payment: 'PayPal authentication failed (HTTP 400)',
    setup: 'PayPal refused the setup (HTTP 400)',
    confirm: 'PayPal order could not be read (HTTP 400)',
    charge: { providerCode: '400', error: 'PayPal refused the request (HTTP 400)' },
    revoke: 'PayPal could not delete the vault token (HTTP 400)',
    lookup: 'PayPal transaction search failed (HTTP 400)',
    raw: { orders: INVALID_CLIENT, vault: INVALID_CLIENT, search: INVALID_CLIENT },
  },
  {
    name: 'token 401',
    tokenPlan: [401],
    errorCode: 'PROVIDER_AUTH_FAILED',
    payment: 'PayPal authentication failed (HTTP 401)',
    setup: 'PayPal refused the setup (HTTP 401)',
    confirm: 'PayPal order could not be read (HTTP 401)',
    charge: { providerCode: '401', error: 'PayPal refused the request (HTTP 401)' },
    revoke: 'PayPal could not delete the vault token (HTTP 401)',
    lookup: 'PayPal transaction search failed (HTTP 401)',
    raw: { orders: INVALID_CLIENT, vault: INVALID_CLIENT, search: INVALID_CLIENT },
  },
  {
    name: 'token 403',
    tokenPlan: [403],
    errorCode: 'PROVIDER_AUTH_UNAVAILABLE',
    payment: 'Response status code was not ok: 403.',
    setup: 'PayPal refused the setup (HTTP 403)',
    confirm: 'PayPal order could not be read (HTTP 403)',
    charge: { providerCode: '403', error: 'PayPal refused the request (HTTP 403)' },
    revoke: 'PayPal could not delete the vault token (HTTP 403)',
    lookup: 'PayPal transaction search failed (HTTP 403)',
    raw: {},
  },
  {
    name: 'token 404',
    tokenPlan: [404],
    errorCode: 'PROVIDER_AUTH_UNAVAILABLE',
    payment: 'Response status code was not ok: 404.',
    setup: 'PayPal refused the setup (HTTP 404)',
    confirm: 'PayPal order could not be read (HTTP 404)',
    charge: { providerCode: '404', error: 'PayPal refused the request (HTTP 404)' },
    revoke: 'PayPal could not delete the vault token (HTTP 404)',
    lookup: 'PayPal transaction search failed (HTTP 404)',
    raw: {},
  },
  {
    name: 'token 429',
    tokenPlan: [429],
    errorCode: 'PROVIDER_AUTH_UNAVAILABLE',
    payment: 'Response status code was not ok: 429.',
    setup: 'PayPal refused the setup (HTTP 429)',
    confirm: 'PayPal order could not be read (HTTP 429)',
    charge: { providerCode: '429', error: 'PayPal refused the request (HTTP 429)' },
    revoke: 'PayPal could not delete the vault token (HTTP 429)',
    lookup: 'PayPal transaction search failed (HTTP 429)',
    raw: {},
  },
  {
    name: 'token 500',
    tokenPlan: [500],
    errorCode: 'PROVIDER_AUTH_UNAVAILABLE',
    payment: 'Response status code was not ok: 500.',
    setup: 'PayPal refused the setup (HTTP 500)',
    confirm: 'PayPal order could not be read (HTTP 500)',
    charge: { error: 'PayPal charge outcome unknown (HTTP 500)' },
    revoke: 'PayPal could not delete the vault token (HTTP 500)',
    lookup: 'PayPal transaction search failed (HTTP 500)',
    raw: {},
  },
  {
    name: 'token 503',
    tokenPlan: [503],
    errorCode: 'PROVIDER_AUTH_UNAVAILABLE',
    payment: 'Response status code was not ok: 503.',
    setup: 'PayPal refused the setup (HTTP 503)',
    confirm: 'PayPal order could not be read (HTTP 503)',
    charge: { error: 'PayPal charge outcome unknown (HTTP 503)' },
    revoke: 'PayPal could not delete the vault token (HTTP 503)',
    lookup: 'PayPal transaction search failed (HTTP 503)',
    raw: {},
  },
  {
    name: 'token reset',
    tokenPlan: ['reset'],
    errorCode: 'PROVIDER_AUTH_UNAVAILABLE',
    payment: 'socket hang up',
    setup: 'Failed to create PayPal mandate setup',
    confirm: 'PayPal order could not be read',
    charge: { error: 'PayPal charge outcome unknown (network error)' },
    revoke: 'PayPal could not delete the vault token',
    lookup: 'PayPal transaction search failed',
    raw: {},
  },
  {
    name: 'token no answer (timeoutMs: 400)',
    tokenPlan: ['hang'],
    timeoutMs: 400,
    errorCode: 'PROVIDER_AUTH_UNAVAILABLE',
    payment: 'timeout of 400ms exceeded',
    setup: 'Failed to create PayPal mandate setup',
    confirm: 'PayPal order could not be read',
    charge: { error: 'PayPal charge outcome unknown (network error)' },
    revoke: 'PayPal could not delete the vault token',
    lookup: 'PayPal transaction search failed',
    raw: {},
  },
  {
    name: 'API 401 (token issued)',
    tokenPlan: [200],
    apiUnauthorized: true,
    errorCode: 'PROVIDER_AUTH_FAILED',
    payment: 'PayPal authentication failed (HTTP 401)',
    setup: 'PayPal refused the setup (HTTP 401)',
    confirm: 'PayPal order could not be read (HTTP 401)',
    charge: { providerCode: '401', error: 'PayPal refused the request (HTTP 401)' },
    revoke: 'PayPal could not delete the vault token (HTTP 401 AUTHENTICATION_FAILURE)',
    lookup: 'PayPal transaction search failed (HTTP 401)',
    raw: { orders: AUTHENTICATION_FAILURE },
  },
];

interface Run<T> {
  result: T;
  /** The requests the fake received during the call. */
  requests: string[];
  /** Every event the configurator emitted during the call. */
  events: [CheckoutEventName, CheckoutEventPayload][];
}

/**
 * One call on a fresh provider (it holds no token yet), registered on a fresh configurator that records every event.
 * No result and no event payload carries a credential.
 */
async function run<T>(
  scenario: Scenario,
  call: (provider: PayPalProvider, checkout: CheckoutConfigurator) => Promise<T>,
): Promise<Run<T>> {
  fake.tokenPlan = scenario.tokenPlan;
  fake.tokenRequests = 0;
  fake.apiUnauthorized = scenario.apiUnauthorized === true;
  fake.requests.length = 0;
  const provider = newProvider(scenario.timeoutMs !== undefined ? { timeoutMs: scenario.timeoutMs } : {});
  const checkout = new CheckoutConfigurator().registerProvider(provider);
  const events: [CheckoutEventName, CheckoutEventPayload][] = [];
  for (const name of ALL_EVENTS) {
    checkout.events.on(name, (payload) => {
      events.push([name, payload]);
    });
  }
  const result = await call(provider, checkout);
  const requests = [...fake.requests];
  expectNoCredentials(result);
  for (const [, payload] of events) expectNoCredentials(payload);
  return { result, requests, events };
}

/** `raw` as a key of an expected result, only when PayPal's error body is expected. */
const withRaw = (raw: unknown): { raw?: unknown } => (raw !== undefined ? { raw } : {});

// The no-answer scenario waits 400 ms per call
const SLOW = 15_000;

describe.each(SCENARIOS)('PayPal $name (#53, real SDK)', (scenario) => {
  const { errorCode } = scenario;
  /** In every token scenario only the token request is sent; with API 401, the token request and `api`. */
  const sent = (api: string): string[] => (scenario.apiUnauthorized ? [TOKEN, api] : [TOKEN]);

  it(
    'createPayment, executePayment, handleRedirect and getPaymentDetails: { success: false, errorCode, error }',
    async () => {
      const expected = { success: false, errorCode, error: scenario.payment };
      const created = await run(scenario, (p) => p.createPayment(paymentRequest));
      expect(created.result).toEqual(expected);
      expect(created.requests).toEqual(sent(CREATE_ORDER));

      const executed = await run(scenario, (p) => p.executePayment('ORD-1'));
      expect(executed.result).toEqual(expected);
      expect(executed.requests).toEqual(sent(CAPTURE));

      const redirected = await run(scenario, (p) => p.handleRedirect({ token: 'ORD-1' }));
      expect(redirected.result).toEqual(expected);
      expect(redirected.requests).toEqual(sent(CAPTURE));

      const details = await run(scenario, (p) => p.getPaymentDetails('ORD-1'));
      expect(details.result).toEqual(expected);
      expect(details.requests).toEqual(sent(READ));
    },
    SLOW,
  );

  it(
    scenario.apiUnauthorized
      ? 'refundPayment (direct, with a key, through the configurator): still uncertain, no status'
      : "refundPayment (direct, with a key, through the configurator): 'REFUND_FAILED' with its paymentId, nothing was sent",
    async () => {
      const expected = scenario.apiUnauthorized
        ? { success: false, errorCode: 'PROVIDER_AUTH_FAILED', error: 'PayPal authentication failed (HTTP 401)' }
        : { success: false, paymentId: 'ORD-1', status: 'REFUND_FAILED', errorCode, error: scenario.payment };

      const direct = await run(scenario, (p) => p.refundPayment('ORD-1', 5));
      expect(direct.result).toEqual(expected);
      expect(direct.requests).toEqual(sent(READ));

      const keyed = await run(scenario, (p) => p.refundPayment('ORD-1', 5, { idempotencyKey: 'refund-ORD-1-R1' }));
      expect(keyed.result).toEqual(expected);
      expect(keyed.requests).toEqual(sent(READ));

      const through = await run(scenario, (_p, checkout) => checkout.refundPayment('paypal', 'ORD-1', 5));
      expect(through.result).toEqual(expected);
      expect(through.requests).toEqual(sent(READ));
      // payment.refunded keeps its payload: no errorCode in it
      expect(through.events.map(([name]) => name)).toEqual(['payment.refunded']);
      const [, refunded] = through.events[0];
      expect(refunded).toEqual({
        provider: 'paypal',
        paymentId: 'ORD-1',
        orderId: undefined,
        status: scenario.apiUnauthorized ? undefined : 'REFUND_FAILED',
        error: expected.error,
        verified: false,
        raw: undefined,
        timestamp: expect.any(Date),
      });
      expect('errorCode' in refunded).toBe(false);
    },
    SLOW,
  );

  it(
    'createMandate (direct and through the configurator): { success: false, errorCode, error }',
    async () => {
      const expected = { success: false, errorCode, error: scenario.setup, ...withRaw(scenario.raw.orders) };
      const direct = await run(scenario, (p) => p.createMandate(setupRequest));
      expect(direct.result).toEqual(expected);
      expect(direct.requests).toEqual(sent(CREATE_ORDER));

      const through = await run(scenario, (_p, checkout) => checkout.createMandate('paypal', setupRequest));
      expect(through.result).toEqual(expected);
      expect(through.requests).toEqual(sent(CREATE_ORDER));
      expect(through.events).toEqual([]);
    },
    SLOW,
  );

  it(
    'confirmMandate (direct and through the configurator): unverified, non-terminal, top-level errorCode only, no event',
    async () => {
      const expected = {
        success: false,
        verified: false,
        terminal: false,
        errorCode,
        error: scenario.confirm,
        firstCharge: { status: 'unknown', verified: false, chargeRef: 'SUB-0001-INIT', error: scenario.confirm },
        ...withRaw(scenario.raw.orders),
      };
      const direct = await run(scenario, (p) => p.confirmMandate(pending, { query: { token: 'ORD-1' } }));
      expect(direct.result).toEqual(expected);
      // The code describes the call, not the charge
      expect('errorCode' in direct.result.firstCharge).toBe(false);
      expect(direct.requests).toEqual(sent(READ));

      const through = await run(scenario, (_p, checkout) =>
        checkout.confirmMandate('paypal', pending, { query: { token: 'ORD-1' } }),
      );
      expect(through.result).toEqual(expected);
      expect('errorCode' in through.result.firstCharge).toBe(false);
      expect(through.requests).toEqual(sent(READ));
      expect(through.events).toEqual([]);
    },
    SLOW,
  );

  it(
    'chargeMandate (direct and through the configurator): always unknown and unverified, charge.unknown with data.errorCode',
    async () => {
      const expected = {
        status: 'unknown',
        verified: false,
        chargeRef: 'SUB-0001-2026-12',
        errorCode,
        ...scenario.charge,
        ...withRaw(scenario.raw.orders),
      };
      const direct = await run(scenario, (p) => p.chargeMandate(mandate, charge));
      expect(direct.result).toEqual(expected);
      expect(direct.requests).toEqual(sent(CREATE_ORDER));

      const through = await run(scenario, (_p, checkout) => checkout.chargeMandate('paypal', mandate, charge));
      expect(through.result).toEqual(expected);
      expect(through.requests).toEqual(sent(CREATE_ORDER));
      // Never charge.failed: not a decline
      expect(through.events.map(([name]) => name)).toEqual(['charge.unknown']);
      expect(through.events[0][1]).toMatchObject({
        provider: 'paypal',
        orderId: 'SUB-0001-2026-12',
        status: 'unknown',
        verified: false,
        error: scenario.charge.error,
        data: { mandateRef: 'MNDT0000000001', errorCode, providerCode: scenario.charge.providerCode },
      });
    },
    SLOW,
  );

  it(
    'getMandate (direct and through the configurator): { status: unknown, verified: false, errorCode }, never revoked',
    async () => {
      const expected = { status: 'unknown', verified: false, errorCode, ...withRaw(scenario.raw.vault) };
      const direct = await run(scenario, (p) => p.getMandate(mandate));
      expect(direct.result).toEqual(expected);
      expect(direct.requests).toEqual(sent(READ_TOKEN));

      const through = await run(scenario, (_p, checkout) => checkout.getMandate('paypal', mandate));
      expect(through.result).toEqual(expected);
      expect(through.requests).toEqual(sent(READ_TOKEN));
      expect(through.events).toEqual([]);
    },
    SLOW,
  );

  it(
    'revokeMandate (direct and through the configurator): { revokedAtProvider: false, errorCode, error }, mandate.revoked unchanged',
    async () => {
      const expected = { revokedAtProvider: false, errorCode, error: scenario.revoke, ...withRaw(scenario.raw.vault) };
      const direct = await run(scenario, (p) => p.revokeMandate(mandate));
      expect(direct.result).toEqual(expected);
      expect(direct.requests).toEqual(sent(DELETE_TOKEN));

      const through = await run(scenario, (_p, checkout) => checkout.revokeMandate('paypal', mandate));
      expect(through.result).toEqual(expected);
      expect(through.requests).toEqual(sent(DELETE_TOKEN));
      expect(through.events.map(([name]) => name)).toEqual(['mandate.revoked']);
      const [, revoked] = through.events[0];
      expect(revoked.data).toStrictEqual({ mandateRef: 'MNDT0000000001', revokedAtProvider: false });
      expect(revoked).toMatchObject({ provider: 'paypal', status: 'revoked', verified: false, error: scenario.revoke });
      expect('errorCode' in revoked).toBe(false);
    },
    SLOW,
  );

  it(
    'getCharge (direct and through the configurator): { status: unknown, verified: false, chargeRef, errorCode, error }',
    async () => {
      const expected = {
        status: 'unknown',
        verified: false,
        chargeRef: 'SUB-0001-2026-12',
        errorCode,
        error: scenario.lookup,
        ...withRaw(scenario.raw.search),
      };
      const direct = await run(scenario, (p) => p.getCharge('SUB-0001-2026-12', { since: SINCE }));
      expect(direct.result).toEqual(expected);
      expect(direct.requests).toEqual(sent(SEARCH));

      const through = await run(scenario, (_p, checkout) => checkout.getCharge('paypal', 'SUB-0001-2026-12', { since: SINCE }));
      expect(through.result).toEqual(expected);
      expect(through.requests).toEqual(sent(SEARCH));
      expect(through.events).toEqual([]);
    },
    SLOW,
  );
});

describe('PayPal API 401 once a token is held (#53, real SDK)', () => {
  it('sends no new token request: exactly one API request per call, each with PROVIDER_AUTH_FAILED', async () => {
    fake.tokenPlan = [200];
    fake.apiUnauthorized = true;
    const provider = newProvider();

    const first = await provider.getPaymentDetails('ORD-1');
    const second = await provider.getPaymentDetails('ORD-1');
    for (const result of [first, second]) {
      expect(result).toEqual({
        success: false,
        errorCode: 'PROVIDER_AUTH_FAILED',
        error: 'PayPal authentication failed (HTTP 401)',
      });
      expectNoCredentials(result);
    }
    // The SDK keeps its token after an API 401 (requesting a new one is out of scope)
    expect(fake.requests).toEqual([TOKEN, READ, READ]);
  });
});
