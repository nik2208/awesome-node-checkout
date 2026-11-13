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

    it('(c) CANCELED is verified, terminal, with a failed first charge when the replayed payment answers 4xx', async () => {
      routes({
        [`GET ${TOKENS}/tok_1`]: () => resp(200, { id: 'tok_1', status: 'CANCELED' }),
        // The customer declined: no payment exists for the key, Satispay refuses the canceled token
        [`POST ${PAYMENTS}`]: () => resp(400, { code: 36, message: 'token canceled' }),
      });
      const outcome = await provider.confirmMandate(pending, {});
      expect(outcome.success).toBe(false);
      expect(outcome.verified).toBe(true);
      expect(outcome.terminal).toBe(true);
      expect(outcome.error).toBe('Authorization canceled');
      expect(outcome.firstCharge).toEqual({
        status: 'failed',
        verified: true,
        chargeRef: 'SUB-0001-INIT',
        error: 'Authorization canceled',
      });
      expect(outcome.mandate).toBeUndefined();
      // The token re-read, then one POST replaying the first payment (same body and key as the
      // ACCEPTED branch); no second token read
      expect(calls().map((c) => c.key)).toEqual([`GET ${TOKENS}/tok_1`, `POST ${PAYMENTS}`]);
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

  describe('re-confirming an unknown first charge after the authorization was canceled', () => {
    const timeout = () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    };

    function recordEvents(checkout: CheckoutConfigurator): Array<[string, unknown]> {
      const events: Array<[string, unknown]> = [];
      for (const name of [
        'mandate.created',
        'mandate.setup_failed',
        'charge.succeeded',
        'charge.failed',
        'charge.unknown',
      ] as const) {
        checkout.events.on(name, (payload) => {
          events.push([name, payload]);
        });
      }
      return events;
    }

    function setup(): { checkout: CheckoutConfigurator; events: Array<[string, unknown]> } {
      const checkout = new CheckoutConfigurator();
      checkout.registerProvider(provider);
      return { checkout, events: recordEvents(checkout) };
    }

    async function firstRunUnknown(checkout: CheckoutConfigurator) {
      routes({
        [`GET ${TOKENS}/tok_1`]: () => resp(200, { id: 'tok_1', status: 'ACCEPTED' }),
        [`POST ${PAYMENTS}`]: timeout,
      });
      const o1 = await checkout.confirmMandate('satispay', pending, { query: { token_id: 'tok_1' } });
      expect(o1).toMatchObject({ success: true, verified: true, terminal: true });
      expect(o1.firstCharge.status).toBe('unknown');
    }

    /** Both POSTs (first run, replay) carry the same body and the same Idempotency-Key. */
    function expectIdenticalReplay() {
      const posts = calls().filter((c) => c.key === `POST ${PAYMENTS}`);
      expect(posts).toHaveLength(2);
      expect(bodyOf(posts[1].init)).toEqual(bodyOf(posts[0].init));
      expect(headersOf(posts[0].init)['Idempotency-Key']).toBe('SUB-0001-INIT');
      expect(headersOf(posts[1].init)['Idempotency-Key']).toBe('SUB-0001-INIT');
      // No token re-read after the replay: only the two setup re-reads
      expect(calls().filter((c) => c.key === `GET ${TOKENS}/tok_1`)).toHaveLength(2);
    }

    function canceledReplay(post: Route) {
      routes({
        [`GET ${TOKENS}/tok_1`]: () => resp(200, { id: 'tok_1', status: 'CANCELED' }),
        [`POST ${PAYMENTS}`]: post,
      });
    }

    it('replay ACCEPTED: success false, terminal, with the succeeded first charge to refund or keep', async () => {
      const { checkout, events } = setup();
      await firstRunUnknown(checkout);

      canceledReplay(() => resp(200, acceptedPayment));
      const o2 = await checkout.confirmMandate('satispay', pending, {});
      expect(o2).toMatchObject({
        success: false,
        verified: true,
        terminal: true,
        error: 'Authorization canceled after the first charge',
      });
      expect(o2.mandate).toBeUndefined();
      expect(o2.firstCharge).toMatchObject({
        status: 'succeeded',
        verified: true,
        chargeRef: 'SUB-0001-INIT',
        providerPaymentId: 'pay_1',
        amount: 19.9,
        currency: 'EUR',
      });
      expectIdenticalReplay();

      expect(events.map(([name]) => name)).toEqual([
        'mandate.created',
        'charge.unknown',
        'mandate.setup_failed',
        'charge.succeeded',
      ]);
      expect(events.find(([name]) => name === 'mandate.setup_failed')![1]).toMatchObject({
        orderId: 'SUB-0001-INIT',
        error: 'Authorization canceled after the first charge',
        raw: { id: '[redacted]', status: 'CANCELED' },
      });
      // The resolution of the earlier charge.unknown, refundable by paymentId
      expect(events.find(([name]) => name === 'charge.succeeded')![1]).toMatchObject({
        orderId: 'SUB-0001-INIT',
        paymentId: 'pay_1',
        verified: true,
      });
      // The token id never reaches an event, also when the setup failed and no mandate is returned
      for (const [, payload] of events) expect(JSON.stringify(payload)).not.toContain('tok_1');
    });

    it('replay 4xx: a verified failed first charge (no payment exists for the key)', async () => {
      const { checkout, events } = setup();
      await firstRunUnknown(checkout);

      canceledReplay(() => resp(400, { code: 36, message: 'token canceled' }));
      const o2 = await checkout.confirmMandate('satispay', pending, {});
      expect(o2).toMatchObject({ success: false, verified: true, terminal: true, error: 'Authorization canceled' });
      expect(o2.mandate).toBeUndefined();
      expect(o2.firstCharge).toEqual({
        status: 'failed',
        verified: true,
        chargeRef: 'SUB-0001-INIT',
        error: 'Authorization canceled',
      });
      expectIdenticalReplay();

      expect(events.map(([name]) => name)).toEqual([
        'mandate.created',
        'charge.unknown',
        'mandate.setup_failed',
        'charge.failed',
      ]);
      expect(events.find(([name]) => name === 'charge.failed')![1]).toMatchObject({
        orderId: 'SUB-0001-INIT',
        verified: true,
        error: 'Authorization canceled',
      });
      for (const [, payload] of events) expect(JSON.stringify(payload)).not.toContain('tok_1');
    });

    it('replay 5xx, 401, 403, 429, 408, 409 or a network error: unverified, non-terminal, no events', async () => {
      const cases: Array<[string, Route]> = [
        ...[500, 503, 401, 403, 429, 408, 409].map((status): [string, Route] => [
          `HTTP ${status}`,
          () => resp(status, { code: 0, message: 'x' }),
        ]),
        ['network error', timeout],
      ];
      for (const [label, post] of cases) {
        vi.clearAllMocks();
        const { checkout, events } = setup();
        await firstRunUnknown(checkout);

        canceledReplay(post);
        const o2 = await checkout.confirmMandate('satispay', pending, {});
        expect(o2, label).toMatchObject({ success: false, verified: false, terminal: false });
        expect(o2.mandate, label).toBeUndefined();
        expect(o2.firstCharge, label).toMatchObject({
          status: 'unknown',
          verified: false,
          chargeRef: 'SUB-0001-INIT',
        });
        expectIdenticalReplay();
        // Only the first run's events: a non-terminal re-confirm emits nothing
        expect(events.map(([name]) => name), label).toEqual(['mandate.created', 'charge.unknown']);
      }
    });
  });

  it('two concurrent confirms: a 409 on the duplicate first payment is unknown, never failed', async () => {
    let post = 0;
    routes({
      [`GET ${TOKENS}/tok_1`]: () => resp(200, { id: 'tok_1', status: 'ACCEPTED' }),
      [`POST ${PAYMENTS}`]: () => (++post === 1 ? resp(200, acceptedPayment) : resp(409, { code: 0, message: 'conflict' })),
    });
    const checkout = new CheckoutConfigurator();
    checkout.registerProvider(provider);
    const [a, b] = await Promise.all([
      checkout.confirmMandate('satispay', pending, { query: { token_id: 'tok_1' } }),
      checkout.confirmMandate('satispay', pending, {}),
    ]);
    // Whichever request reached Satispay second got the 409
    const [first, second] = a.firstCharge.status === 'succeeded' ? [a, b] : [b, a];
    expect(first.firstCharge).toMatchObject({ status: 'succeeded', verified: true, providerPaymentId: 'pay_1' });
    expect(second.success).toBe(true);
    expect(second.firstCharge).toMatchObject({ status: 'unknown', verified: false, chargeRef: 'SUB-0001-INIT' });
    expect(calls().filter((c) => c.key === `POST ${PAYMENTS}`)).toHaveLength(2);
    // No token GET after the 409: only the two setup re-reads
    expect(calls().filter((c) => c.key === `GET ${TOKENS}/tok_1`)).toHaveLength(2);
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

    it.each([401, 403, 408, 409, 429])('%i → unknown, with no token GET', async (status) => {
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
  // 7. refundPayment: the documented flow, a checked outcome, the idempotency key (#44)
  // ---------------------------------------------------------------------------

  describe('refundPayment (#44)', () => {
    const refund = { id: 'ref_1', type: 'REFUND_TO_BUSINESS', status: 'ACCEPTED', amount_unit: 1990, currency: 'EUR' };
    const payment = { id: 'pay_1', status: 'ACCEPTED', amount_unit: 1990, currency: 'EUR' };

    it('declares supportsRefundIdempotency', () => {
      expect(provider.supportsRefundIdempotency).toBe(true);
    });

    it("refundPayment('pay_1', 19.9) makes exactly one signed POST /payments with flow REFUND and no Idempotency-Key", async () => {
      routes({ [`POST ${PAYMENTS}`]: () => resp(200, refund) });

      const result = await provider.refundPayment('pay_1', 19.9);

      expect(fetchMock()).toHaveBeenCalledTimes(1);
      const [{ url, init }] = calls();
      expect(url).toBe('https://staging.authservices.satispay.com/g_business/v1/payments');
      expect(init.method).toBe('POST');
      expect(bodyOf(init)).toEqual({ flow: 'REFUND', parent_payment_uid: 'pay_1', amount_unit: 1990, currency: 'EUR' });
      expect(Object.keys(headersOf(init)).map((h) => h.toLowerCase())).not.toContain('idempotency-key');
      expect(verifySignature(url, init, validFakePublicKey)).toBe(true);
      expect(result).toMatchObject({
        success: true,
        verified: true,
        paymentId: 'ref_1',
        status: 'ACCEPTED',
        amount: 19.9,
        currency: 'EUR',
      });
      expect(result.raw).toEqual(refund);
    });

    it('with { idempotencyKey } the POST carries Idempotency-Key, and Digest and Authorization still sign the body', async () => {
      routes({ [`POST ${PAYMENTS}`]: () => resp(200, refund) });

      const result = await provider.refundPayment('pay_1', 19.9, { idempotencyKey: 'refund-SUB-0001-R1' });

      const [{ url, init }] = calls();
      const headers = headersOf(init);
      expect(headers['Idempotency-Key']).toBe('refund-SUB-0001-R1');
      expect(headers['Digest']).toBe(
        'SHA-256=' + crypto.createHash('sha256').update(String(init.body)).digest('base64'),
      );
      expect(headers['Authorization']).toContain('headers="(request-target) host date digest"');
      expect(verifySignature(url, init, validFakePublicKey)).toBe(true);
      expect(bodyOf(init)).toEqual({ flow: 'REFUND', parent_payment_uid: 'pay_1', amount_unit: 1990, currency: 'EUR' });
      expect(result.success).toBe(true);
    });

    it("200 { id: 'ref_1', status: 'PENDING' } is not a success, and not verified", async () => {
      routes({ [`POST ${PAYMENTS}`]: () => resp(200, { id: 'ref_1', status: 'PENDING' }) });
      const result = await provider.refundPayment('pay_1', 19.9);
      expect(result).toMatchObject({ success: false, status: 'PENDING', error: 'Satispay refund is PENDING' });
      expect(result.verified).not.toBe(true);
    });

    it("200 with type: 'TO_BUSINESS', with no id, or with no JSON is not a success, and not verified", async () => {
      for (const body of [{ ...refund, type: 'TO_BUSINESS' }, { ...refund, id: '' }, { status: 'ACCEPTED' }, 'not json']) {
        routes({ [`POST ${PAYMENTS}`]: () => resp(200, body) });
        const result = await provider.refundPayment('pay_1', 19.9);
        expect(result.success).toBe(false);
        expect(result.verified).not.toBe(true);
      }
      routes({ [`POST ${PAYMENTS}`]: () => resp(200, 'not json') });
      expect(await provider.refundPayment('pay_1', 19.9)).toMatchObject({
        success: false,
        status: 'UNKNOWN',
        error: 'Satispay refund is UNKNOWN',
      });
    });

    it("400 { code: 36, message } is an authenticated refusal: { success: false, verified: true, status: 'REFUND_FAILED', error }", async () => {
      routes({ [`POST ${PAYMENTS}`]: () => resp(400, { code: 36, message: 'Refund amount exceeds the payment' }) });
      const result = await provider.refundPayment('pay_1', 19.9);
      expect(result).toMatchObject({
        success: false,
        verified: true,
        status: 'REFUND_FAILED',
        error: 'Refund amount exceeds the payment',
      });
    });

    it("a 4xx refusal without a message is 'Satispay refused the refund'", async () => {
      routes({ [`POST ${PAYMENTS}`]: () => resp(422, { code: 99 }) });
      expect(await provider.refundPayment('pay_1', 19.9)).toMatchObject({
        success: false,
        verified: true,
        status: 'REFUND_FAILED',
        error: 'Satispay refused the refund',
      });
    });

    it.each([401, 403, 408, 409, 429, 500, 503])('HTTP %i is an unknown outcome: success false, not verified', async (status) => {
      routes({ [`POST ${PAYMENTS}`]: () => resp(status, { message: 'busy' }) });
      const result = await provider.refundPayment('pay_1', 19.9);
      expect(result).toMatchObject({ success: false, error: `Satispay refund outcome unknown (HTTP ${status})` });
      expect(result.verified).not.toBe(true);
    });

    it('a network error or a timeout is an unknown outcome: success false, not verified', async () => {
      for (const failure of [
        new TypeError('fetch failed'),
        Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
      ]) {
        fetchMock().mockRejectedValueOnce(failure);
        const result = await provider.refundPayment('pay_1', 19.9);
        expect(result).toEqual({ success: false, error: 'Satispay refund outcome unknown (network error or timeout)' });
      }
    });

    it("full refund: refundPayment('pay_1') reads the payment, then refunds its amount_unit", async () => {
      routes({
        [`GET ${PAYMENTS}/pay_1`]: () => resp(200, payment),
        [`POST ${PAYMENTS}`]: () => resp(200, refund),
      });

      const result = await provider.refundPayment('pay_1');

      expect(calls().map((c) => c.key)).toEqual([`GET ${PAYMENTS}/pay_1`, `POST ${PAYMENTS}`]);
      expect(verifySignature(calls()[0].url, calls()[0].init, validFakePublicKey)).toBe(true);
      expect(bodyOf(calls()[1].init)).toEqual({
        flow: 'REFUND',
        parent_payment_uid: 'pay_1',
        amount_unit: 1990,
        currency: 'EUR',
      });
      expect(result).toMatchObject({ success: true, verified: true, paymentId: 'ref_1', amount: 19.9 });
    });

    it.each([
      ['404', () => resp(404, { code: 404 })],
      ['503', () => resp(503, { message: 'down' })],
      ["id: 'pay_2'", () => resp(200, { ...payment, id: 'pay_2' })],
      ["status: 'CANCELED'", () => resp(200, { ...payment, status: 'CANCELED' })],
      ['amount_unit: 0', () => resp(200, { ...payment, amount_unit: 0 })],
      ["amount_unit: '1990'", () => resp(200, { ...payment, amount_unit: '1990' })],
    ])('full refund: a read answering %s sends no refund', async (_label, read) => {
      routes({ [`GET ${PAYMENTS}/pay_1`]: read, [`POST ${PAYMENTS}`]: () => resp(200, refund) });
      const result = await provider.refundPayment('pay_1');
      expect(result).toEqual({
        success: false,
        status: 'REFUND_FAILED',
        error: 'Satispay payment could not be read: no refund was sent',
      });
      expect(calls().map((c) => c.key)).toEqual([`GET ${PAYMENTS}/pay_1`]);
    });

    it('full refund: a read that times out sends no refund', async () => {
      routes({
        [`GET ${PAYMENTS}/pay_1`]: () => {
          throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
        },
      });
      expect(await provider.refundPayment('pay_1')).toMatchObject({ success: false, status: 'REFUND_FAILED' });
      expect(calls()).toHaveLength(1);
    });

    it('timeout: no signal without config.timeoutMs; an AbortSignal of config.timeoutMs with it', async () => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      routes({
        [`GET ${PAYMENTS}/pay_1`]: () => resp(200, payment),
        [`POST ${PAYMENTS}`]: () => resp(200, refund),
      });

      await provider.refundPayment('pay_1', 19.9);
      await provider.refundPayment('pay_1');
      expect(calls()).toHaveLength(3);
      for (const { init } of calls()) expect(init.signal).toBeUndefined();
      expect(timeout).not.toHaveBeenCalled();

      const bounded = new SatispayProvider({ keyId: 'test-key', privateKey: validFakePrivateKey, timeoutMs: 5000 });
      await bounded.refundPayment('pay_1', 19.9);
      await bounded.refundPayment('pay_1');
      expect(calls()).toHaveLength(6);
      for (const { init } of calls().slice(3)) expect(init.signal).toBeDefined();
      expect(timeout.mock.calls).toEqual([[5000], [5000], [5000]]);
      timeout.mockRestore();
    });

    it('called directly with a key that does not match REFUND_IDEMPOTENCY_KEY_PATTERN, refuses without any request', async () => {
      for (const idempotencyKey of ['', 'short', 'has space 1', 'x'.repeat(65), 123 as unknown as string]) {
        const result = await provider.refundPayment('pay_1', 19.9, { idempotencyKey });
        expect(result).toMatchObject({ success: false, status: 'REFUND_FAILED' });
        expect(result.verified).not.toBe(true);
      }
      expect(fetchMock()).not.toHaveBeenCalled();
    });

    it('an invalid payment id or amount still fails without any request, as in 2.1', async () => {
      expect(await provider.refundPayment('pay/1', 19.9)).toMatchObject({
        success: false,
        status: 'REFUND_FAILED',
        error: 'Invalid payment ID format',
      });
      expect(await provider.refundPayment('pay_1', 19.999)).toMatchObject({ success: false, status: 'FAILED' });
      expect(fetchMock()).not.toHaveBeenCalled();
    });

    it('through the configurator, the key reaches Satispay and payment.refunded is verified for ACCEPTED', async () => {
      routes({ [`POST ${PAYMENTS}`]: () => resp(200, refund) });
      const checkout = new CheckoutConfigurator();
      checkout.registerProvider(provider);
      const events: any[] = [];
      checkout.events.on('payment.refunded', (payload) => {
        events.push(payload);
      });
      const result = await checkout.refundPayment('satispay', 'pay_1', 19.9, { idempotencyKey: 'refund-SUB-0001-R1' });
      expect(result.success).toBe(true);
      expect(headersOf(calls()[0].init)['Idempotency-Key']).toBe('refund-SUB-0001-R1');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ provider: 'satispay', paymentId: 'pay_1', status: 'ACCEPTED', verified: true });
    });
  });
});
