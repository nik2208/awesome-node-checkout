import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PayPalProvider, PayPalProviderConfig } from './paypal.provider';
import { Mandate } from '../../models/mandate.model';

// A failed OAuth token request (#45), with the real PayPal SDK 2.5.0: no mock. The SDK keeps the token
// request of a client and makes every later call of that client wait for it, so in 2.1 one failed token
// request (a timeout, a reset connection, an HTTP error) made every later call of the provider fail at once,
// with nothing sent, until the app built a new provider.
//
// A local fake PayPal answers instead of api-m.sandbox.paypal.com: axios sends every request, in clear text and
// with its absolute URL, to the proxy named by `https_proxy`, so nothing leaves the machine, and every test
// checks the requests the fake received.

type TokenStep = 'hang' | 'reset' | number;

const PROXY_ENV = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY'];

const CLIENT_ID = 'CLIENT-ID-0001';
const CLIENT_SECRET = 'CLIENT-SECRET-0001';
const ACCESS_TOKEN = 'A21AA-FAKE-ACCESS-TOKEN';

const fake = {
  server: undefined as http.Server | undefined,
  /** Answers of the successive token requests; the last one repeats. */
  tokenPlan: [] as TokenStep[],
  tokenRequests: 0,
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
    json(res, step ?? 500, { error: 'invalid_client', error_description: 'Client Authentication failed' });
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

describe('PayPalProvider after a failed OAuth token request (real SDK, #45)', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const server = http.createServer(answer);
    fake.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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
    fake.requests.length = 0;
    // The SDK logs every request and response (logLevel 'error')
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Drops the token request left hanging, and the SDK's idle connections
    fake.server?.closeAllConnections();
  });

  it('with timeoutMs, a token request that never answers fails the call waiting for it; the next call requests a new token', async () => {
    fake.tokenPlan = ['hang', 200];
    const provider = newProvider({ timeoutMs: 300 });

    const first = await provider.getPaymentDetails('ORD-1');
    // The 2.1 result of a network error: the message only, no verified
    expect(first).toEqual({ success: false, error: 'timeout of 300ms exceeded' });
    expectNoCredentials(first);
    expect(fake.requests).toEqual([TOKEN]);

    const second = await provider.getPaymentDetails('ORD-1');
    expect(second).toMatchObject({ success: true, verified: true, paymentId: 'ORD-1', status: 'COMPLETED', amount: 19.9 });
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
    });
    const unavailable = await provider.chargeMandate(mandate, charge);
    expect(unavailable).toMatchObject({
      status: 'unknown',
      verified: false,
      chargeRef: 'SUB-0001-2026-12',
      error: 'PayPal charge outcome unknown (HTTP 503)',
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
    expect(fake.requests).toEqual([TOKEN, TOKEN, TOKEN, 'POST /v2/checkout/orders']);
  });
});
