import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import { NexiProvider, NexiProviderConfig } from './nexi.provider';
import { CheckoutConfigurator } from '../../checkout-configurator';
import { isChargeLookupProvider } from '../../index';

// Public charge lookup on Nexi XPay (`getCharge`, #40, with refundedAmount from #41) and the
// `getPaymentDetails` entry selection fix (#40 §5).
// Fixtures copied from nexi.mandates.spec.ts:16-49. The MACs are literals computed independently
// of the implementation.

const MERCHANT_ID = 'ALIAS_TEST_01';
const MAC_KEY = 'TEST_SECRET_KEY_0001';
const NOW = 1767225600000;

/** SHA-1 of `esito=OKidOperazione=123456789timeStamp=1767225601000TEST_SECRET_KEY_0001`. */
const MAC_API_RESPONSE_OK = '2a8dbadc3faa3fe66c9f67f9d360da3039ce207a';
/** SHA-1 of `apiKey=ALIAS_TEST_01codiceTransazione=SUB-0001-2026-12timeStamp=1767225600000TEST_SECRET_KEY_0001`. */
const MAC_STATUS_REQUEST = '7676dedfa18d9bfe7390eda42e1d4942d823e8f5';

const OK_RESP = { esito: 'OK', idOperazione: '123456789', timeStamp: '1767225601000', mac: MAC_API_RESPONSE_OK };

const CHARGE = 'SUB-0001-2026-12';
const PAID_ENTRY = { codiceTransazione: CHARGE, stato: 'Autorizzato', importo: 1990, divisa: 'EUR' };

/** Marker placed in response bodies: it must never reach `error`. */
const SECRET_BODY = 'SECRET-BODY-CONTENT';

/** Fixture input only (a KO response with a valid MAC has no literal vector): never asserted. */
function signedKo(codice: number): Record<string, unknown> {
  const idOperazione = '123456790';
  const timeStamp = '1767225601000';
  const mac = crypto
    .createHash('sha1')
    .update(`esito=KOidOperazione=${idOperazione}timeStamp=${timeStamp}${MAC_KEY}`)
    .digest('hex');
  return { esito: 'KO', idOperazione, timeStamp, errore: { codice, messaggio: 'not found' }, mac };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function fetchMock() {
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}

function reportResponse(report: unknown[]) {
  return jsonResponse({ ...OK_RESP, report });
}

describe('NexiProvider.getCharge (#40)', () => {
  const baseConfig: NexiProviderConfig = { merchantId: MERCHANT_ID, macKey: MAC_KEY, environment: 'sandbox' };
  let provider: NexiProvider;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    provider = new NexiProvider(baseConfig);
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('implements the charge lookup capability', () => {
    expect(isChargeLookupProvider(provider)).toBe(true);
    expect(new CheckoutConfigurator({ emitEvents: false }).registerProvider(provider).supportsChargeLookup('nexi')).toBe(true);
  });

  it('posts situazioneOrdine with the status MAC and a timeout signal, and nothing else', async () => {
    fetchMock().mockResolvedValueOnce(reportResponse([PAID_ENTRY]));
    await provider.getCharge(CHARGE);
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://int-ecommerce.nexi.it/ecomm/api/bo/situazioneOrdine');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      apiKey: 'ALIAS_TEST_01',
      codiceTransazione: 'SUB-0001-2026-12',
      timeStamp: '1767225600000',
      mac: '7676dedfa18d9bfe7390eda42e1d4942d823e8f5',
    });
    expect(JSON.parse(String(init.body)).mac).toBe(MAC_STATUS_REQUEST);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('options are ignored', async () => {
    fetchMock().mockResolvedValueOnce(reportResponse([PAID_ENTRY]));
    const result = await provider.getCharge(CHARGE, { since: 'not a date', until: '', mandate: undefined });
    expect(result.status).toBe('succeeded');
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it('report [PAID_ENTRY] is succeeded with the entry amount, currency and stato', async () => {
    fetchMock().mockResolvedValueOnce(reportResponse([PAID_ENTRY]));
    const result = await provider.getCharge(CHARGE);
    expect(result).toMatchObject({
      status: 'succeeded',
      verified: true,
      chargeRef: 'SUB-0001-2026-12',
      providerPaymentId: 'SUB-0001-2026-12',
      amount: 19.9,
      currency: 'EUR',
      providerStatus: 'Autorizzato',
    });
    expect('providerState' in result).toBe(false);
    expect('error' in result).toBe(false);
    // raw is the parsed situazioneOrdine answer
    expect(result.raw).toEqual({ ...OK_RESP, report: [PAID_ENTRY] });
  });

  describe('several entries', () => {
    const entry = (stato: string) => ({ ...PAID_ENTRY, stato });

    it('[Negato, Autorizzato] is succeeded', async () => {
      fetchMock().mockResolvedValueOnce(reportResponse([entry('Negato'), PAID_ENTRY]));
      const result = await provider.getCharge(CHARGE);
      expect(result.status).toBe('succeeded');
      expect(result.verified).toBe(true);
      expect(result.providerStatus).toBe('Autorizzato');
    });

    it('[Negato, Annullato] is failed and verified', async () => {
      fetchMock().mockResolvedValueOnce(reportResponse([entry('Negato'), entry('Annullato')]));
      const result = await provider.getCharge(CHARGE);
      expect(result.status).toBe('failed');
      expect(result.verified).toBe(true);
      expect(result.providerStatus).toBe('Negato');
      expect('providerPaymentId' in result).toBe(false);
    });

    it("[In Corso] is pending and verified, with providerStatus 'In Corso'", async () => {
      fetchMock().mockResolvedValueOnce(reportResponse([entry('In Corso')]));
      const result = await provider.getCharge(CHARGE);
      expect(result.status).toBe('pending');
      expect(result.verified).toBe(true);
      expect(result.providerStatus).toBe('In Corso');
    });

    it("an unrecognised stato ('Sospeso') is pending", async () => {
      fetchMock().mockResolvedValueOnce(reportResponse([entry('Sospeso')]));
      const result = await provider.getCharge(CHARGE);
      expect(result.status).toBe('pending');
      expect(result.verified).toBe(true);
      expect(result.providerStatus).toBe('Sospeso');
    });

    it('an entry without stato is pending, without providerStatus', async () => {
      fetchMock().mockResolvedValueOnce(reportResponse([{ codiceTransazione: CHARGE, importo: 1990, divisa: 'EUR' }]));
      const result = await provider.getCharge(CHARGE);
      expect(result.status).toBe('pending');
      expect(result.verified).toBe(true);
      expect('providerStatus' in result).toBe(false);
    });

    it('[Negato, In Corso] is pending: an attempt that is not final may still take money', async () => {
      fetchMock().mockResolvedValueOnce(reportResponse([entry('Negato'), entry('In Corso')]));
      const result = await provider.getCharge(CHARGE);
      expect(result.status).toBe('pending');
      expect(result.providerStatus).toBe('In Corso');
    });
  });

  it.each([
    [' Rimborsato Parz. ', 'partially_refunded', 'Rimborsato Parz.'],
    ['RIMBORSATO', 'refunded', 'RIMBORSATO'],
    ['Contabilizzato Parz.', 'partially_captured', 'Contabilizzato Parz.'],
  ])('stato %j is succeeded with providerState %s and providerStatus %j', async (stato, providerState, providerStatus) => {
    fetchMock().mockResolvedValueOnce(reportResponse([{ ...PAID_ENTRY, stato }]));
    const result = await provider.getCharge(CHARGE);
    expect(result.status).toBe('succeeded');
    expect(result.verified).toBe(true);
    expect(result.providerState).toBe(providerState);
    expect(result.providerStatus).toBe(providerStatus);
  });

  it('[Autorizzato, Rimborsato] reports the most specific fact: refunded', async () => {
    fetchMock().mockResolvedValueOnce(
      reportResponse([
        { ...PAID_ENTRY, stato: 'Autorizzato' },
        { ...PAID_ENTRY, stato: 'Rimborsato' },
      ]),
    );
    const result = await provider.getCharge(CHARGE);
    expect(result.status).toBe('succeeded');
    expect(result.providerState).toBe('refunded');
    expect(result.providerStatus).toBe('Rimborsato');
  });

  it('[Autorizzato 19.90, Contabilizzato Parz. 10.00] reports the partial capture entry: its amount and state', async () => {
    fetchMock().mockResolvedValueOnce(
      reportResponse([PAID_ENTRY, { ...PAID_ENTRY, stato: 'Contabilizzato Parz.', importo: 1000 }]),
    );
    const result = await provider.getCharge(CHARGE);
    expect(result).toMatchObject({
      status: 'succeeded',
      verified: true,
      amount: 10,
      currency: 'EUR',
      providerStatus: 'Contabilizzato Parz.',
      providerState: 'partially_captured',
      refundedAmount: 0,
    });
  });

  describe('absent', () => {
    it('an OK with an empty report is absent and verified', async () => {
      fetchMock().mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [] }));
      const result = await provider.getCharge(CHARGE);
      expect(result).toMatchObject({ status: 'absent', verified: true, chargeRef: CHARGE });
      expect('providerPaymentId' in result).toBe(false);
      expect('error' in result).toBe(false);
    });

    it('a report whose only entry has another codiceTransazione is absent and verified', async () => {
      fetchMock().mockResolvedValueOnce(reportResponse([{ ...PAID_ENTRY, codiceTransazione: 'SUB-0002-2026-12' }]));
      const result = await provider.getCharge(CHARGE);
      expect(result.status).toBe('absent');
      expect(result.verified).toBe(true);
    });

    it.each([2, 13])('a signed KO %i is absent and verified', async (codice) => {
      fetchMock().mockResolvedValueOnce(jsonResponse(signedKo(codice)));
      const result = await provider.getCharge(CHARGE);
      expect(result.status).toBe('absent');
      expect(result.verified).toBe(true);
    });

    it.each([2, 13])('the same KO %i without a MAC is unknown: an unsigned "not found" says nothing', async (codice) => {
      const body = signedKo(codice);
      delete body.mac;
      fetchMock().mockResolvedValueOnce(jsonResponse(body));
      const result = await provider.getCharge(CHARGE);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.error).toBe('Nexi "not found" answer carries no MAC');
    });

    it('a signed KO 99 is unknown', async () => {
      fetchMock().mockResolvedValueOnce(jsonResponse(signedKo(99)));
      const result = await provider.getCharge(CHARGE);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
    });
  });

  describe('unknown, never with the response body in error', () => {
    const { mac: _mac, ...unsignedOk } = OK_RESP;

    it.each([
      ['an OK without mac', jsonResponse({ ...unsignedOk, report: [PAID_ENTRY], note: SECRET_BODY })],
      ['an OK with a wrong mac', jsonResponse({ ...OK_RESP, mac: '0'.repeat(40), report: [PAID_ENTRY], note: SECRET_BODY })],
      ['an OK without report', jsonResponse({ ...OK_RESP, note: SECRET_BODY })],
      ['a KO with a wrong mac', jsonResponse({ ...signedKo(2), mac: MAC_API_RESPONSE_OK, note: SECRET_BODY })],
    ])('%s is unknown', async (_label, response) => {
      fetchMock().mockResolvedValueOnce(response);
      const result = await provider.getCharge(CHARGE);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.error).toBe('Nexi charge lookup failed');
      expect(result.error).not.toContain(SECRET_BODY);
      expect('providerPaymentId' in result).toBe(false);
    });

    it('HTTP 500 is unknown', async () => {
      fetchMock().mockResolvedValueOnce(jsonResponse({ detail: SECRET_BODY }, 500));
      const result = await provider.getCharge(CHARGE);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.error).toBe('Nexi API error: HTTP 500');
    });

    it('a non-JSON body is unknown', async () => {
      fetchMock().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError(`Unexpected token < in ${SECRET_BODY}`);
        },
      });
      const result = await provider.getCharge(CHARGE);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.error).toBe('Invalid provider response');
    });

    it('a rejected fetch is unknown', async () => {
      fetchMock().mockRejectedValueOnce(new Error(`getaddrinfo ENOTFOUND ${SECRET_BODY}`));
      const result = await provider.getCharge(CHARGE);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.error).toBe('Nexi API network error');
    });

    it("a timeout (timeoutMs: 5, fetch aborted on its signal) is unknown with 'Nexi API timeout'", async () => {
      provider = new NexiProvider({ ...baseConfig, timeoutMs: 5 });
      fetchMock().mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => {
              reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
            });
          }),
      );
      const result = await provider.getCharge(CHARGE);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.error).toBe('Nexi API timeout');
    });
  });

  it('called directly with an invalid chargeRef, it is unknown without calling Nexi', async () => {
    for (const chargeRef of ['SUB_0001', 'x', 42 as unknown as string]) {
      const result = await provider.getCharge(chargeRef);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
    }
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  describe('refundedAmount (#41)', () => {
    it.each(['Autorizzato', 'Contabilizzato Parz.', 'Contabilizzato', 'Catturato'])(
      '%s is refundedAmount 0',
      async (stato) => {
        fetchMock().mockResolvedValueOnce(reportResponse([{ ...PAID_ENTRY, stato }]));
        const result = await provider.getCharge(CHARGE);
        expect(result.status).toBe('succeeded');
        expect(result.refundedAmount).toBe(0);
      },
    );

    it.each(['Rimborsato', 'Rimborsato Parz.'])('%s has no refundedAmount: Nexi documents no refunded amount', async (stato) => {
      fetchMock().mockResolvedValueOnce(reportResponse([{ ...PAID_ENTRY, stato }]));
      const result = await provider.getCharge(CHARGE);
      expect(result.status).toBe('succeeded');
      expect('refundedAmount' in result).toBe(false);
    });

    it('Negato, In Corso and an empty report have no refundedAmount', async () => {
      for (const report of [[{ ...PAID_ENTRY, stato: 'Negato' }], [{ ...PAID_ENTRY, stato: 'In Corso' }], []]) {
        fetchMock().mockResolvedValueOnce(reportResponse(report));
        const result = await provider.getCharge(CHARGE);
        expect(result.status).not.toBe('succeeded');
        expect('refundedAmount' in result).toBe(false);
      }
    });
  });
});

describe('NexiProvider.getPaymentDetails reads every report entry (#40 §5)', () => {
  let provider: NexiProvider;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    provider = new NexiProvider({ merchantId: MERCHANT_ID, macKey: MAC_KEY });
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("[Negato, Contabilizzato] is success: true, status 'Contabilizzato' (2.1.0: success false, 'Negato')", async () => {
    fetchMock().mockResolvedValueOnce(
      reportResponse([
        { codiceTransazione: CHARGE, stato: 'Negato', importo: '1999', divisa: 'EUR' },
        { codiceTransazione: CHARGE, stato: 'Contabilizzato', importo: '1999', divisa: 'EUR' },
      ]),
    );
    const result = await provider.getPaymentDetails(CHARGE);
    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.status).toBe('Contabilizzato');
    expect(result.amount).toBe(19.99);
    expect(result.currency).toBe('EUR');
    expect(result.error).toBeUndefined();
  });

  it("[Rimborsato] stays success: false, status 'Rimborsato', verified: true", async () => {
    fetchMock().mockResolvedValueOnce(reportResponse([{ ...PAID_ENTRY, stato: 'Rimborsato' }]));
    const result = await provider.getPaymentDetails(CHARGE);
    expect(result.success).toBe(false);
    expect(result.status).toBe('Rimborsato');
    expect(result.verified).toBe(true);
    expect(result.error).toBe('Payment status is Rimborsato');
  });

  // A report whose first entry is paid keeps its 2.1.0 result: the fix only turns a wrong "not paid" into the right
  // answer, never a 2.1.0 "paid" into "not paid" (getCharge reports the refund or partial capture as providerState)
  it("[Autorizzato, Rimborsato] keeps the 2.1.0 result: success true, status 'Autorizzato'", async () => {
    fetchMock().mockResolvedValueOnce(
      reportResponse([
        { ...PAID_ENTRY, stato: 'Autorizzato' },
        { ...PAID_ENTRY, stato: 'Rimborsato' },
      ]),
    );
    const result = await provider.getPaymentDetails(CHARGE);
    expect(result.success).toBe(true);
    expect(result.status).toBe('Autorizzato');
    expect(result.amount).toBe(19.9);
    expect(result.verified).toBe(true);
  });

  it("[Autorizzato 19.90, Contabilizzato Parz. 10.00] keeps the 2.1.0 result: success true, 'Autorizzato', 19.9", async () => {
    fetchMock().mockResolvedValueOnce(
      reportResponse([PAID_ENTRY, { ...PAID_ENTRY, stato: 'Contabilizzato Parz.', importo: 1000 }]),
    );
    const result = await provider.getPaymentDetails(CHARGE);
    expect(result.success).toBe(true);
    expect(result.status).toBe('Autorizzato');
    expect(result.amount).toBe(19.9);
    expect(result.currency).toBe('EUR');
    expect(result.error).toBeUndefined();
  });

  it("[Rimborsato, Autorizzato] reports the first paid entry, as in 2.1.0: success false, 'Rimborsato'", async () => {
    fetchMock().mockResolvedValueOnce(reportResponse([{ ...PAID_ENTRY, stato: 'Rimborsato' }, PAID_ENTRY]));
    const result = await provider.getPaymentDetails(CHARGE);
    expect(result.success).toBe(false);
    expect(result.status).toBe('Rimborsato');
  });

  it("[Negato, In Corso] reports the attempt that is not final: 'In Corso'", async () => {
    fetchMock().mockResolvedValueOnce(
      reportResponse([
        { ...PAID_ENTRY, stato: 'Negato' },
        { ...PAID_ENTRY, stato: 'In Corso' },
      ]),
    );
    const result = await provider.getPaymentDetails(CHARGE);
    expect(result.success).toBe(false);
    expect(result.status).toBe('In Corso');
  });

  it("[] is 'Report not found', without verified (unchanged)", async () => {
    fetchMock().mockResolvedValueOnce(reportResponse([]));
    const result = await provider.getPaymentDetails(CHARGE);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Report not found');
    expect('verified' in result).toBe(false);
  });

  it('keeps its transport: a plain fetch without a timeout signal (unchanged)', async () => {
    fetchMock().mockResolvedValueOnce(reportResponse([PAID_ENTRY]));
    await provider.getPaymentDetails(CHARGE);
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://int-ecommerce.nexi.it/ecomm/api/bo/situazioneOrdine');
    expect(init.signal).toBeUndefined();
    expect(JSON.parse(String(init.body)).mac).toBe('7676dedfa18d9bfe7390eda42e1d4942d823e8f5');
  });
});
