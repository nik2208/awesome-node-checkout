import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import * as crypto from 'crypto';
import { SatispayProvider } from './satispay.provider';
import { CheckoutConfigurator } from '../../checkout-configurator';
import { isMandateProvider } from '../../interfaces/mandate-provider.interface';
import { Mandate, MandatePendingState, MandateSetupRequest } from '../../models/mandate.model';

const API = 'https://staging.authservices.satispay.com/g_business/v1';
const TOKENS = `${API}/pre_authorized_payment_tokens`;
const PAYMENTS = `${API}/payments`;

type MockResponse = { ok: boolean; status: number; text: () => Promise<string> };
type Route = (init: RequestInit) => MockResponse | Promise<MockResponse>;

function resp(status: number, body?: unknown): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const fetchMock = () => global.fetch as unknown as ReturnType<typeof vi.fn>;

/** Dispatches the fetch mock on "METHOD url" instead of call order. */
function routes(table: Record<string, Route>): void {
  fetchMock().mockImplementation(async (url: string, init: RequestInit) => {
    const key = `${String(init?.method ?? 'GET').toUpperCase()} ${url}`;
    const route = table[key];
    if (!route) throw new Error(`Unexpected fetch: ${key}`);
    return route(init);
  });
}

function calls(): Array<{ url: string; init: RequestInit; key: string }> {
  return fetchMock().mock.calls.map(([url, init]: [string, RequestInit]) => ({
    url,
    init,
    key: `${String(init?.method ?? 'GET').toUpperCase()} ${url}`,
  }));
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

/** Recomputes the HTTP Signature over `(request-target) host date digest` and verifies it. */
function verifySignature(url: string, init: RequestInit, publicKey: string): boolean {
  const headers = headersOf(init);
  const parsed = new URL(url);
  const bodyString = init.body === undefined ? '' : String(init.body);
  const expectedDigest = 'SHA-256=' + crypto.createHash('sha256').update(bodyString).digest('base64');
  if (headers['Digest'] !== expectedDigest) return false;
  if (headers['Host'] !== parsed.host) return false;
  const auth = headers['Authorization'];
  if (!auth.startsWith('Signature keyId="test-key", algorithm="rsa-sha256", ')) return false;
  if (!auth.includes('headers="(request-target) host date digest"')) return false;
  const match = /signature="([^"]+)"/.exec(auth);
  if (!match) return false;
  const message =
    `(request-target): ${String(init.method).toLowerCase()} ${parsed.pathname}\n` +
    `host: ${parsed.host}\n` +
    `date: ${headers['Date']}\n` +
    `digest: ${headers['Digest']}`;
  const verify = crypto.createVerify('RSA-SHA256');
  verify.update(message);
  return verify.verify(publicKey, match[1], 'base64');
}

describe('SatispayProvider mandates (pre-authorized payment tokens)', () => {
  let provider: SatispayProvider;
  let validFakePrivateKey: string;
  let validFakePublicKey: string;

  const setupRequest: MandateSetupRequest = {
    mandateRef: 'MNDT0000000001',
    orderId: 'SUB-0001-INIT',
    amount: 19.9,
    currency: 'EUR',
    description: 'Pro monthly subscription',
    returnUrl: 'http://localhost/checkout/satispay/mandate/callback',
    cancelUrl: 'http://localhost/checkout/satispay/mandate/callback',
  };

  const pending: MandatePendingState = {
    provider: 'satispay',
    mandateRef: 'MNDT0000000001',
    orderId: 'SUB-0001-INIT',
    amount: 19.9,
    currency: 'EUR',
    providerRef: 'tok_1',
    createdAt: '2026-11-12T10:00:00.000Z',
  };

  const mandate: Mandate = {
    provider: 'satispay',
    mandateRef: 'MNDT0000000001',
    providerMandateId: 'tok_1',
    status: 'active',
    createdAt: '2026-11-12T10:00:00.000Z',
  };

  const acceptedPayment = {
    id: 'pay_1',
    status: 'ACCEPTED',
    amount_unit: 1990,
    currency: 'EUR',
    external_code: 'SUB-0001-INIT',
  };

  beforeAll(() => {
    // Generate a fast valid RSA key pair
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    } as any);
    validFakePrivateKey = privateKey as string;
    validFakePublicKey = publicKey as string;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    provider = new SatispayProvider({
      keyId: 'test-key',
      privateKey: validFakePrivateKey,
      environment: 'sandbox',
      serverUrl: 'http://localhost',
    });

    // Mock global fetch
    global.fetch = vi.fn();
  });

  it('implements IMandateProvider', () => {
    expect(isMandateProvider(provider)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 1. createMandate
  // ---------------------------------------------------------------------------

  describe('createMandate', () => {
    it('POSTs a signed authorization with Idempotency-Key and the raw {uuid} placeholder', async () => {
      routes({
        [`POST ${TOKENS}`]: () =>
          resp(200, { id: 'tok_1', status: 'PENDING', redirect_url: 'https://staging.online.satispay.com/pat/tok_1' }),
      });

      const start = await provider.createMandate(setupRequest);

      expect(fetchMock()).toHaveBeenCalledTimes(1);
      const [{ url, init }] = calls();
      expect(url).toBe('https://staging.authservices.satispay.com/g_business/v1/pre_authorized_payment_tokens');
      expect(init.method).toBe('POST');
      const headers = headersOf(init);
      expect(headers['Idempotency-Key']).toBe('setup-SUB-0001-INIT');
      expect(headers['Authorization']).toMatch(/^Signature /);
      expect(verifySignature(url, init, validFakePublicKey)).toBe(true);

      const body = bodyOf(init);
      expect(body.callback_url).toBe(
        'http://localhost/checkout/satispay/mandate/callback?mandate_ref=MNDT0000000001&token_id={uuid}',
      );
      expect(String(init.body)).not.toContain('%7B');
      expect(String(init.body)).not.toContain('%7D');
      expect(String(body.redirect_url)).toContain('mandate_ref=MNDT0000000001');
      expect(body.redirect_url).toBe(
        'http://localhost/checkout/satispay/mandate/callback?mandate_ref=MNDT0000000001',
      );
      expect(body.reason).toBe('Pro monthly subscription');

      expect(start.success).toBe(true);
      expect(start.approvalUrl).toBe('https://staging.online.satispay.com/pat/tok_1');
      expect(start.pending?.providerRef).toBe('tok_1');
      expect(start.pending).toMatchObject({
        provider: 'satispay',
        mandateRef: 'MNDT0000000001',
        orderId: 'SUB-0001-INIT',
        amount: 19.9,
        currency: 'EUR',
        providerRef: 'tok_1',
      });
      expect(typeof start.pending?.createdAt).toBe('string');
    });

    it('uses notifyUrl as callback base when set, and a custom mandateCallbackPath otherwise', async () => {
      routes({
        [`POST ${TOKENS}`]: () => resp(200, { id: 'tok_1', status: 'PENDING', redirect_url: 'https://r.test/x' }),
      });

      await provider.createMandate({ ...setupRequest, notifyUrl: 'https://app.test/cb?x=1' });
      expect(bodyOf(calls()[0].init).callback_url).toBe(
        'https://app.test/cb?x=1&mandate_ref=MNDT0000000001&token_id={uuid}',
      );

      const custom = new SatispayProvider({
        keyId: 'test-key',
        privateKey: validFakePrivateKey,
        serverUrl: 'https://app.test',
        mandateCallbackPath: '/pay/satispay/mandate/callback',
      });
      await custom.createMandate(setupRequest);
      expect(bodyOf(calls()[1].init).callback_url).toBe(
        'https://app.test/pay/satispay/mandate/callback?mandate_ref=MNDT0000000001&token_id={uuid}',
      );
    });

    it('without serverUrl and notifyUrl returns success: false and makes no fetch call', async () => {
      const noServer = new SatispayProvider({ keyId: 'test-key', privateKey: validFakePrivateKey });
      const start = await noServer.createMandate(setupRequest);
      expect(start.success).toBe(false);
      expect(start.error).toBe('Satispay mandates require notifyUrl or serverUrl');
      expect(fetchMock()).not.toHaveBeenCalled();
    });

    it('rejects a non-EUR currency without a fetch call', async () => {
      const start = await provider.createMandate({ ...setupRequest, currency: 'USD' });
      expect(start).toEqual({ success: false, error: 'Satispay mandates support EUR only' });
      expect(fetchMock()).not.toHaveBeenCalled();
    });

    it('returns a generic error without the body on a non-2xx or an incomplete response', async () => {
      routes({ [`POST ${TOKENS}`]: () => resp(400, { code: 99, message: 'secret detail tok_9' }) });
      const failed = await provider.createMandate(setupRequest);
      expect(failed.success).toBe(false);
      expect(failed.error).not.toContain('secret detail');
      expect(failed.error).not.toContain('tok_9');
      expect(failed.pending).toBeUndefined();

      routes({ [`POST ${TOKENS}`]: () => resp(200, { id: 'tok_1', status: 'PENDING' }) });
      const incomplete = await provider.createMandate(setupRequest);
      expect(incomplete.success).toBe(false);

      fetchMock().mockRejectedValue(new Error('ECONNRESET'));
      const network = await provider.createMandate(setupRequest);
      expect(network.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. confirmMandate, ACCEPTED
  // ---------------------------------------------------------------------------

  describe('confirmMandate, ACCEPTED', () => {
    beforeEach(() => {
      routes({
        [`GET ${TOKENS}/tok_1`]: () => resp(200, { id: 'tok_1', status: 'ACCEPTED' }),
        [`POST ${PAYMENTS}`]: () => resp(200, acceptedPayment),
      });
    });

    it('activates the mandate and makes the first PRE_AUTHORIZED charge', async () => {
      const outcome = await provider.confirmMandate(pending, { query: { mandate_ref: 'MNDT0000000001', token_id: 'tok_1' } });

      expect(outcome.success).toBe(true);
      expect(outcome.verified).toBe(true);
      expect(outcome.terminal).toBe(true);
      expect(outcome.mandate?.providerMandateId).toBe('tok_1');
      expect(outcome.mandate).toMatchObject({ provider: 'satispay', mandateRef: 'MNDT0000000001', status: 'active' });
      expect(outcome.firstCharge.status).toBe('succeeded');
      expect(outcome.firstCharge.providerPaymentId).toBe('pay_1');
      expect(outcome.firstCharge.chargeRef).toBe('SUB-0001-INIT');
      expect(outcome.firstCharge.verified).toBe(true);
      expect(outcome.firstCharge.amount).toBe(19.9);
      expect(outcome.firstCharge.currency).toBe('EUR');

      const post = calls().find((c) => c.key === `POST ${PAYMENTS}`)!;
      expect(bodyOf(post.init)).toEqual({
        flow: 'PRE_AUTHORIZED',
        token: 'tok_1',
        amount_unit: 1990,
        currency: 'EUR',
        external_code: 'SUB-0001-INIT',
      });
      expect(headersOf(post.init)['Idempotency-Key']).toBe('SUB-0001-INIT');
    });

    it('sends the same Idempotency-Key when confirmed twice', async () => {
      await provider.confirmMandate(pending, { query: { token_id: 'tok_1' } });
      await provider.confirmMandate(pending, {});

      const posts = calls().filter((c) => c.key === `POST ${PAYMENTS}`);
      expect(posts).toHaveLength(2);
      expect(headersOf(posts[0].init)['Idempotency-Key']).toBe('SUB-0001-INIT');
      expect(headersOf(posts[1].init)['Idempotency-Key']).toBe('SUB-0001-INIT');
      expect(bodyOf(posts[0].init)).toEqual(bodyOf(posts[1].init));
    });

    it('passes the configurator normalization (smoke test)', async () => {
      const checkout = new CheckoutConfigurator();
      checkout.registerProvider(provider);
      const outcome = await checkout.confirmMandate('satispay', pending, {});
      expect(outcome.success).toBe(true);
      expect(outcome.terminal).toBe(true);
      expect(outcome.firstCharge.status).toBe('succeeded');
      expect(outcome.mandate?.providerMandateId).toBe('tok_1');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. confirmMandate, other outcomes
  // ---------------------------------------------------------------------------

  describe('confirmMandate, other outcomes', () => {
    it('(a) a callback token_id other than pending.providerRef is rejected without a fetch call', async () => {
      const outcome = await provider.confirmMandate(pending, { query: { token_id: 'tok_X' } });
      expect(outcome.success).toBe(false);
      expect(outcome.verified).toBe(false);
      expect(outcome.terminal).toBe(false);
      expect(outcome.firstCharge).toEqual({ status: 'unknown', verified: false, chargeRef: 'SUB-0001-INIT' });
      expect(fetchMock()).not.toHaveBeenCalled();
    });

    it('(b) PENDING is verified, non-terminal, and never calls /payments', async () => {
      routes({ [`GET ${TOKENS}/tok_1`]: () => resp(200, { id: 'tok_1', status: 'PENDING' }) });
      const outcome = await provider.confirmMandate(pending, {});
      expect(outcome.success).toBe(false);
      expect(outcome.verified).toBe(true);
      expect(outcome.terminal).toBe(false);
      expect(outcome.error).toBe('AUTHORIZATION_PENDING');
      expect(outcome.firstCharge).toEqual({
        status: 'unknown',
        verified: false,
        chargeRef: 'SUB-0001-INIT',
        error: 'Authorization still pending',
      });
      expect(calls().some((c) => c.url === PAYMENTS)).toBe(false);

      const checkout = new CheckoutConfigurator();
      checkout.registerProvider(provider);
      const normalized = await checkout.confirmMandate('satispay', pending, {});
      expect(normalized.terminal).toBe(false);
      expect(normalized.success).toBe(false);
    });

    it('(c) CANCELED is verified, terminal, with a failed first charge', async () => {
      routes({ [`GET ${TOKENS}/tok_1`]: () => resp(200, { id: 'tok_1', status: 'CANCELED' }) });
      const outcome = await provider.confirmMandate(pending, {});
      expect(outcome.success).toBe(false);
      expect(outcome.verified).toBe(true);
      expect(outcome.terminal).toBe(true);
      expect(outcome.firstCharge.status).toBe('failed');
      expect(outcome.firstCharge.verified).toBe(true);
      expect(outcome.firstCharge.error).toBe('Authorization canceled');
      expect(outcome.mandate).toBeUndefined();
      expect(calls().some((c) => c.url === PAYMENTS)).toBe(false);
    });

    it('(d) a 503 on the token GET is non-terminal with an unknown first charge', async () => {
      routes({ [`GET ${TOKENS}/tok_1`]: () => resp(503, { message: 'down' }) });
      const outcome = await provider.confirmMandate(pending, {});
      expect(outcome.success).toBe(false);
      expect(outcome.verified).toBe(false);
      expect(outcome.terminal).toBe(false);
      expect(outcome.firstCharge.status).toBe('unknown');
    });

    it('(d) 401, 403, 429, a network error and a timeout are non-terminal too', async () => {
      for (const status of [401, 403, 429]) {
        routes({ [`GET ${TOKENS}/tok_1`]: () => resp(status, {}) });
        const outcome = await provider.confirmMandate(pending, {});
        expect(outcome).toMatchObject({ success: false, verified: false, terminal: false });
        expect(outcome.firstCharge.status).toBe('unknown');
      }
      fetchMock().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      const outcome = await provider.confirmMandate(pending, {});
      expect(outcome).toMatchObject({ success: false, verified: false, terminal: false });
      expect(outcome.firstCharge.status).toBe('unknown');
    });

    it('(e) a token GET returning another id is an unverified failure', async () => {
      routes({ [`GET ${TOKENS}/tok_1`]: () => resp(200, { id: 'tok_other', status: 'ACCEPTED' }) });
      const outcome = await provider.confirmMandate(pending, {});
      expect(outcome.success).toBe(false);
      expect(outcome.verified).toBe(false);
      expect(outcome.terminal).toBe(false);
      expect(outcome.mandate).toBeUndefined();
      expect(calls().some((c) => c.url === PAYMENTS)).toBe(false);
    });

    it('an unrecognised status is an unverified, non-terminal failure', async () => {
      routes({ [`GET ${TOKENS}/tok_1`]: () => resp(200, { id: 'tok_1', status: 'WEIRD' }) });
      const outcome = await provider.confirmMandate(pending, {});
      expect(outcome).toMatchObject({ success: false, verified: false, terminal: false });
    });

    it('(f) ACCEPTED with a refused first charge: mandate active, firstCharge failed with providerCode', async () => {
      routes({
        [`GET ${TOKENS}/tok_1`]: () => resp(200, { id: 'tok_1', status: 'ACCEPTED' }),
        [`POST ${PAYMENTS}`]: () => resp(400, { code: 36, message: 'x' }),
      });
      const outcome = await provider.confirmMandate(pending, {});
      expect(outcome.success).toBe(true);
      expect(outcome.verified).toBe(true);
      expect(outcome.terminal).toBe(true);
      expect(outcome.firstCharge.status).toBe('failed');
      expect(outcome.firstCharge.providerCode).toBe('36');
      expect(outcome.firstCharge.error).toBe('x');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. chargeMandate
  // ---------------------------------------------------------------------------

  describe('chargeMandate', () => {
    const charge = { chargeRef: 'SUB-0001-2026-12', amount: 19.9, currency: 'EUR' };
    const accepted = { ...acceptedPayment, id: 'pay_2', external_code: 'SUB-0001-2026-12' };

    it('sends Idempotency-Key = chargeRef and a signature that verifies with the public key', async () => {
      routes({ [`POST ${PAYMENTS}`]: () => resp(200, accepted) });
      await provider.chargeMandate(mandate, { ...charge, description: 'Pro 2026-12' });

      const [{ url, init }] = calls();
      expect(url).toBe('https://staging.authservices.satispay.com/g_business/v1/payments');
      expect(headersOf(init)['Idempotency-Key']).toBe('SUB-0001-2026-12');
      expect(verifySignature(url, init, validFakePublicKey)).toBe(true);
      // Idempotency-Key is not part of the signature
      expect(headersOf(init)['Authorization']).toContain('headers="(request-target) host date digest"');
      expect(bodyOf(init)).toEqual({
        flow: 'PRE_AUTHORIZED',
        token: 'tok_1',
        amount_unit: 1990,
        currency: 'EUR',
        external_code: 'SUB-0001-2026-12',
        metadata: { description: 'Pro 2026-12' },
      });
    });

    it('ACCEPTED → succeeded, verified', async () => {
      routes({ [`POST ${PAYMENTS}`]: () => resp(200, accepted) });
      const result = await provider.chargeMandate(mandate, charge);
      expect(result).toMatchObject({
        status: 'succeeded',
        verified: true,
        chargeRef: 'SUB-0001-2026-12',
        providerPaymentId: 'pay_2',
        amount: 19.9,
        currency: 'EUR',
      });
    });

    it('400 then token CANCELED → failed with mandateUnusable: true', async () => {
      routes({
        [`POST ${PAYMENTS}`]: () => resp(400, { code: 36, message: 'Token canceled' }),
        [`GET ${TOKENS}/tok_1`]: () => resp(200, { id: 'tok_1', status: 'CANCELED' }),
      });
      const result = await provider.chargeMandate(mandate, charge);
      expect(result.status).toBe('failed');
      expect(result.verified).toBe(true);
      expect(result.mandateUnusable).toBe(true);
      expect(result.providerCode).toBe('36');
      expect(calls().map((c) => c.key)).toEqual([`POST ${PAYMENTS}`, `GET ${TOKENS}/tok_1`]);
    });

    it('400 then token 404 → failed with mandateUnusable: true', async () => {
      routes({
        [`POST ${PAYMENTS}`]: () => resp(400, {}),
        [`GET ${TOKENS}/tok_1`]: () => resp(404, {}),
      });
      const result = await provider.chargeMandate(mandate, charge);
      expect(result.status).toBe('failed');
      expect(result.mandateUnusable).toBe(true);
      expect(result.providerCode).toBe('400');
      expect(result.error).toBe('Satispay refused the charge');
    });

    it('400 then token ACCEPTED → failed with mandateUnusable falsy', async () => {
      routes({
        [`POST ${PAYMENTS}`]: () => resp(400, { code: 36, message: 'x' }),
        [`GET ${TOKENS}/tok_1`]: () => resp(200, { id: 'tok_1', status: 'ACCEPTED' }),
      });
      const result = await provider.chargeMandate(mandate, charge);
      expect(result.status).toBe('failed');
      expect(result.mandateUnusable).toBeFalsy();
    });

    it('502 → unknown', async () => {
      routes({ [`POST ${PAYMENTS}`]: () => resp(502, 'Bad Gateway') });
      const result = await provider.chargeMandate(mandate, charge);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(fetchMock()).toHaveBeenCalledTimes(1);
    });

    it.each([401, 403, 429])('%i → unknown, with no token GET', async (status) => {
      routes({ [`POST ${PAYMENTS}`]: () => resp(status, { code: 1, message: 'nope' }) });
      const result = await provider.chargeMandate(mandate, charge);
      expect(result.status).toBe('unknown');
      expect(result.mandateUnusable).toBeFalsy();
      expect(fetchMock()).toHaveBeenCalledTimes(1);
      expect(calls().some((c) => c.url.startsWith(TOKENS))).toBe(false);
    });

    it('fetch rejecting with an AbortError → unknown', async () => {
      fetchMock().mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      const result = await provider.chargeMandate(mandate, charge);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.chargeRef).toBe('SUB-0001-2026-12');
    });

    it('passes an AbortSignal timeout to fetch (config.timeoutMs)', async () => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      const custom = new SatispayProvider({ keyId: 'test-key', privateKey: validFakePrivateKey, timeoutMs: 1234 });
      routes({ [`POST ${PAYMENTS}`]: () => resp(200, accepted) });
      await custom.chargeMandate(mandate, charge);
      expect(timeout).toHaveBeenCalledWith(1234);
      expect(calls()[0].init.signal).toBeDefined();
      await provider.chargeMandate(mandate, charge);
      expect(timeout).toHaveBeenLastCalledWith(30000);
      timeout.mockRestore();
    });

    it("external_code: 'OTHER' on a 200 → unknown", async () => {
      routes({ [`POST ${PAYMENTS}`]: () => resp(200, { ...accepted, external_code: 'OTHER' }) });
      const result = await provider.chargeMandate(mandate, charge);
      expect(result.status).toBe('unknown');
    });

    it('a 200 with another status or an unparseable body → unknown', async () => {
      routes({ [`POST ${PAYMENTS}`]: () => resp(200, { ...accepted, status: 'PENDING' }) });
      expect((await provider.chargeMandate(mandate, charge)).status).toBe('unknown');
      routes({ [`POST ${PAYMENTS}`]: () => resp(200, 'not json') });
      expect((await provider.chargeMandate(mandate, charge)).status).toBe('unknown');
    });

    it("currency: 'USD' → failed with no fetch call", async () => {
      const result = await provider.chargeMandate(mandate, { ...charge, currency: 'USD' });
      expect(result.status).toBe('failed');
      expect(result.verified).toBe(false);
      expect(fetchMock()).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 5. getMandate / revokeMandate
  // ---------------------------------------------------------------------------

  describe('getMandate', () => {
    it.each([
      [200, { id: 'tok_1', status: 'ACCEPTED' }, { status: 'active', verified: true }],
      [200, { id: 'tok_1', status: 'CANCELED' }, { status: 'revoked', verified: true }],
      [404, { code: 404 }, { status: 'revoked', verified: true }],
      [200, { id: 'tok_1', status: 'PENDING' }, { status: 'unknown', verified: true }],
      [500, { message: 'boom' }, { status: 'unknown', verified: false }],
    ])('HTTP %i %j → %j', async (status, body, expected) => {
      routes({ [`GET ${TOKENS}/tok_1`]: () => resp(status, body) });
      const result = await provider.getMandate(mandate);
      expect({ status: result.status, verified: result.verified }).toEqual(expected);
      expect(verifySignature(calls()[0].url, calls()[0].init, validFakePublicKey)).toBe(true);
    });

    it('a token with another id is unknown, unverified', async () => {
      routes({ [`GET ${TOKENS}/tok_1`]: () => resp(200, { id: 'tok_other', status: 'ACCEPTED' }) });
      expect(await provider.getMandate(mandate)).toEqual({ status: 'unknown', verified: false });
    });
  });

  describe('revokeMandate', () => {
    it('returns revokedAtProvider: false and makes no fetch call', async () => {
      const result = await provider.revokeMandate(mandate);
      expect(result).toEqual({
        revokedAtProvider: false,
        error:
          'Satispay does not document a merchant-side revocation; stop charging this mandate. ' +
          'The customer can revoke it from the Satispay app.',
      });
      expect(fetchMock()).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 6. send() header protection
  // ---------------------------------------------------------------------------

  describe('send()', () => {
    it('never lets extraHeaders override Authorization (or Host, Date, Digest)', async () => {
      fetchMock().mockResolvedValue(resp(200, { ok: 1 }));
      const res = await (provider as any).send('POST', PAYMENTS, { a: 1 }, {
        Authorization: 'x',
        authorization: 'y',
        Host: 'evil.test',
        date: 'Thu, 01 Jan 1970 00:00:00 GMT',
        DIGEST: 'SHA-256=forged',
        'Idempotency-Key': 'k-1',
      });
      expect(res).toEqual({ ok: true, status: 200, json: { ok: 1 } });

      const [{ url, init }] = calls();
      const headers = headersOf(init);
      expect(headers['Authorization']).not.toBe('x');
      expect(headers['Authorization']).toMatch(/^Signature keyId="test-key"/);
      expect(headers['authorization']).toBeUndefined();
      expect(headers['date']).toBeUndefined();
      expect(headers['DIGEST']).toBeUndefined();
      expect(headers['Host']).toBe('staging.authservices.satispay.com');
      expect(headers['Idempotency-Key']).toBe('k-1');
      expect(verifySignature(url, init, validFakePublicKey)).toBe(true);
    });

    it('never throws: a network error gives { ok: false, status: 0, networkError: true }', async () => {
      fetchMock().mockRejectedValue(new TypeError('fetch failed'));
      await expect((provider as any).send('GET', `${TOKENS}/tok_1`)).resolves.toEqual({
        ok: false,
        status: 0,
        networkError: true,
      });
    });

    it('keeps the status of a non-2xx and parses JSON defensively', async () => {
      fetchMock().mockResolvedValue(resp(400, { code: 36 }));
      await expect((provider as any).send('GET', `${TOKENS}/tok_1`)).resolves.toEqual({
        ok: false,
        status: 400,
        json: { code: 36 },
      });
      fetchMock().mockResolvedValue(resp(500, '<html>'));
      await expect((provider as any).send('GET', `${TOKENS}/tok_1`)).resolves.toEqual({ ok: false, status: 500 });
      fetchMock().mockResolvedValue(resp(200, '[1,2]'));
      await expect((provider as any).send('GET', `${TOKENS}/tok_1`)).resolves.toEqual({ ok: true, status: 200 });
    });
  });

  // ---------------------------------------------------------------------------
  // 7. refundPayment regression
  // ---------------------------------------------------------------------------

  it("refundPayment('pay_1', 19.9) posts to …/payments/pay_1/refunds", async () => {
    routes({
      [`POST ${PAYMENTS}/pay_1/refunds`]: () => resp(200, { id: 'ref_1', status: 'ACCEPTED' }),
    });
    const result = await provider.refundPayment('pay_1', 19.9);
    expect(result.success).toBe(true);
    const [{ url, init }] = calls();
    expect(url).toBe('https://staging.authservices.satispay.com/g_business/v1/payments/pay_1/refunds');
    expect(init.method).toBe('POST');
    expect(bodyOf(init)).toEqual({ amount_unit: 1990 });
  });
});
