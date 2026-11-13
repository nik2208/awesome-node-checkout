import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import { NexiProvider, NexiProviderConfig } from './nexi.provider';
import { CheckoutConfigurator } from '../../checkout-configurator';
import { CheckoutError } from '../../models/errors';
import type { CheckoutEventPayload } from '../../events/checkout-event-bus';

// Nexi refunds through the documented back-office API "Storno/rimborso" (`POST /ecomm/api/bo/storna`, manual v20.4
// pp. 613-616, fragment 39), with the 2.2.0 request behind `refundApi: 'legacy'` (#51).
// Harness of nexi.mandates.spec.ts (alias, key, fake Date). Every MAC below is a literal from issue #51, "Acceptance
// criteria", computed independently of the implementation: the tests never compare against the provider's own helpers.

const MERCHANT_ID = 'ALIAS_TEST_01';
const MAC_KEY = 'TEST_SECRET_KEY_0001';
const NOW = 1767225600000;
const CODE = 'SUB-0001-2026-12';

/** sha1(`apiKey=ALIAS_TEST_01codiceTransazione=SUB-0001-2026-12divisa=978importo=1990timeStamp=1767225600000TEST_SECRET_KEY_0001`). */
const MAC_STORNA_1990 = 'a369be3e05d8e02bf2996b6980726f76e26a3dea';
/** The same with `importo=500`. */
const MAC_STORNA_500 = 'dfe2fc3c2c29345ff7e5f2a674a5c75b4f324453';
/** sha1(`esito=OKidOperazione=123456789timeStamp=1767225601000TEST_SECRET_KEY_0001`): `MAC_API_RESPONSE_OK` of nexi.mandates.spec.ts. */
const MAC_API_RESPONSE_OK = '2a8dbadc3faa3fe66c9f67f9d360da3039ce207a';
/** sha1(`esito=KOidOperazione=123456790timeStamp=1767225601000TEST_SECRET_KEY_0001`). */
const MAC_API_RESPONSE_KO = 'eb9e3c930e6199e30769edf25cfbe1e5c213cd57';
/** sha1(`apiKey=ALIAS_TEST_01codiceTransazione=SUB-0001-2026-12timeStamp=1767225600000TEST_SECRET_KEY_0001`). */
const MAC_STATUS_REQUEST = '7676dedfa18d9bfe7390eda42e1d4942d823e8f5';
/** sha1(`alias=ALIAS_TEST_01codTrans=SUB-0001-2026-12importo=1990timestamp=2026-01-01T00:00:00.000ZTEST_SECRET_KEY_0001`). */
const MAC_LEGACY_1990 = 'f66c1e3ac0f8d1e209034f0089b9be39fae7aef8';
/** The same with `importo=` (a full refund). */
const MAC_LEGACY_FULL = '3d91e5853fa6602bbdf775af3fab6dba3709ea68';

const STORNA_URL = 'https://int-ecommerce.nexi.it/ecomm/api/bo/storna';
const STATUS_URL = 'https://int-ecommerce.nexi.it/ecomm/api/bo/situazioneOrdine';
const LEGACY_URL = 'https://int-ecommerce.nexi.it/ecomm/api/vas/igfs/storno/plain';

const OK_RESP = { esito: 'OK', idOperazione: '123456789', timeStamp: '1767225601000', mac: MAC_API_RESPONSE_OK };

/** A KO signed with its literal MAC. The MAC does not cover `errore`, so it stays valid whatever `errore` holds. */
const KO_17 = {
  esito: 'KO',
  idOperazione: '123456790',
  timeStamp: '1767225601000',
  errore: { codice: 17, messaggio: 'Importo operazione troppo alto' },
  mac: MAC_API_RESPONSE_KO,
};

/** `KO_17` with another `errore`, or without one: still validly signed. */
function signedKo(errore?: unknown): Record<string, unknown> {
  const { errore: _omitted, ...rest } = KO_17;
  return errore === undefined ? rest : { ...rest, errore };
}

/** Fixture input only (no literal vector for this `esito`): a validly signed answer. Never asserted. */
function signedAnswer(esito: string): Record<string, unknown> {
  const idOperazione = '123456791';
  const timeStamp = '1767225601000';
  const mac = crypto
    .createHash('sha1')
    .update(`esito=${esito}idOperazione=${idOperazione}timeStamp=${timeStamp}${MAC_KEY}`)
    .digest('hex');
  return { esito, idOperazione, timeStamp, mac };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function reportResponse(report: unknown[]): Response {
  return jsonResponse({ ...OK_RESP, report });
}

function entry(stato: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { codiceTransazione: CODE, stato, importo: 1990, divisa: 'EUR', ...overrides };
}

function fetchMock() {
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}

function callUrl(i: number): string {
  return String(fetchMock().mock.calls[i][0]);
}

function callInit(i: number): RequestInit {
  return fetchMock().mock.calls[i][1] as RequestInit;
}

function callBody(i: number): Record<string, unknown> {
  return JSON.parse(String(callInit(i).body));
}

/** The storno body of `refundPayment(CODE, 19.9)` at NOW (issue #51, first acceptance criterion). */
const STORNA_BODY_1990 = {
  apiKey: 'ALIAS_TEST_01',
  codiceTransazione: 'SUB-0001-2026-12',
  importo: '1990',
  divisa: '978',
  timeStamp: '1767225600000',
  mac: 'a369be3e05d8e02bf2996b6980726f76e26a3dea',
};

describe('NexiProvider.refundPayment (#51)', () => {
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

  // ---------------------------------------------------------------------------
  // Request
  // ---------------------------------------------------------------------------
  describe('request: POST /ecomm/api/bo/storna', () => {
    it("refundPayment('SUB-0001-2026-12', 19.9) makes exactly one JSON POST to bo/storna, with no timeout signal", async () => {
      fetchMock().mockResolvedValueOnce(jsonResponse(OK_RESP));
      await provider.refundPayment('SUB-0001-2026-12', 19.9);

      expect(fetchMock()).toHaveBeenCalledTimes(1);
      expect(callUrl(0)).toBe('https://int-ecommerce.nexi.it/ecomm/api/bo/storna');
      const init = callInit(0);
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(init.signal).toBeUndefined();
      expect('signal' in init).toBe(false);
      expect(callBody(0)).toStrictEqual({
        apiKey: 'ALIAS_TEST_01',
        codiceTransazione: 'SUB-0001-2026-12',
        importo: '1990',
        divisa: '978',
        timeStamp: '1767225600000',
        mac: 'a369be3e05d8e02bf2996b6980726f76e26a3dea',
      });
      // The body is in the manual's order; in the MAC, divisa comes before importo
      expect(Object.keys(callBody(0))).toEqual(['apiKey', 'codiceTransazione', 'importo', 'divisa', 'timeStamp', 'mac']);
      expect(callBody(0).mac).toBe(MAC_STORNA_1990);
    });

    it("with environment: 'production' the URL is https://ecommerce.nexi.it/ecomm/api/bo/storna", async () => {
      provider = new NexiProvider({ ...baseConfig, environment: 'production' });
      fetchMock().mockResolvedValueOnce(jsonResponse(OK_RESP));
      await provider.refundPayment('SUB-0001-2026-12', 19.9);
      expect(fetchMock()).toHaveBeenCalledTimes(1);
      expect(callUrl(0)).toBe('https://ecommerce.nexi.it/ecomm/api/bo/storna');
      expect(callBody(0)).toStrictEqual(STORNA_BODY_1990);
    });

    it("refundPayment('SUB-0001-2026-12', 5) sends importo '500' and its MAC", async () => {
      fetchMock().mockResolvedValueOnce(jsonResponse(OK_RESP));
      await provider.refundPayment('SUB-0001-2026-12', 5);
      expect(callBody(0)).toStrictEqual({
        ...STORNA_BODY_1990,
        importo: '500',
        mac: 'dfe2fc3c2c29345ff7e5f2a674a5c75b4f324453',
      });
      expect(callBody(0).mac).toBe(MAC_STORNA_500);
    });

    it('a paymentId of 36 characters is sent as it is, without a length check', async () => {
      const id = '0f8c2d1e-5b7a-4c3e-9d2f-6a1b8e4c7d90';
      fetchMock().mockResolvedValueOnce(jsonResponse(OK_RESP));
      await provider.refundPayment(id, 19.9);
      expect(fetchMock()).toHaveBeenCalledTimes(1);
      expect(callUrl(0)).toBe('https://int-ecommerce.nexi.it/ecomm/api/bo/storna');
      expect(callBody(0).codiceTransazione).toBe('0f8c2d1e-5b7a-4c3e-9d2f-6a1b8e4c7d90');
    });

    it("refundApi: 'storna' and refundApi: undefined send the same request as the default", async () => {
      for (const extra of [{ refundApi: 'storna' as const }, { refundApi: undefined }]) {
        fetchMock().mockReset();
        fetchMock().mockResolvedValueOnce(jsonResponse(OK_RESP));
        await new NexiProvider({ ...baseConfig, ...extra }).refundPayment(CODE, 19.9);
        expect(fetchMock()).toHaveBeenCalledTimes(1);
        expect(callUrl(0)).toBe(STORNA_URL);
        expect(callBody(0)).toStrictEqual(STORNA_BODY_1990);
      }
    });

    it('options without a key send the storno as without options (#44)', async () => {
      fetchMock().mockResolvedValueOnce(jsonResponse(OK_RESP));
      const result = await provider.refundPayment(CODE, 19.9, {});
      expect(fetchMock()).toHaveBeenCalledTimes(1);
      expect(callUrl(0)).toBe(STORNA_URL);
      expect(callBody(0)).toStrictEqual(STORNA_BODY_1990);
      expect(result.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Outcome (issue #51 § Resolution 2.7: the table is total)
  // ---------------------------------------------------------------------------
  describe('outcome', () => {
    it('OK_RESP (esito OK, valid MAC) is a verified refund; paymentId stays the codTrans', async () => {
      fetchMock().mockResolvedValueOnce(jsonResponse(OK_RESP));
      const result = await provider.refundPayment(CODE, 19.9);
      expect(result).toEqual({
        success: true,
        verified: true,
        paymentId: 'SUB-0001-2026-12',
        status: 'REFUNDED',
        raw: OK_RESP,
      });
      // No other key (no amount: the answer carries none); Nexi's idOperazione is in raw
      expect(result).toStrictEqual({
        success: true,
        verified: true,
        paymentId: 'SUB-0001-2026-12',
        status: 'REFUNDED',
        raw: OK_RESP,
      });
      expect((result.raw as Record<string, unknown>).idOperazione).toBe('123456789');
    });

    it("a signed KO 17 is an authenticated refusal with Nexi's message", async () => {
      fetchMock().mockResolvedValueOnce(
        jsonResponse({
          esito: 'KO',
          idOperazione: '123456790',
          timeStamp: '1767225601000',
          errore: { codice: 17, messaggio: 'Importo operazione troppo alto' },
          mac: 'eb9e3c930e6199e30769edf25cfbe1e5c213cd57',
        }),
      );
      const result = await provider.refundPayment(CODE, 19.9);
      expect(result).toStrictEqual({
        success: false,
        verified: true,
        paymentId: 'SUB-0001-2026-12',
        status: 'REFUND_FAILED',
        error: 'Importo operazione troppo alto',
        raw: KO_17,
      });
    });

    it("the same KO with errore { codice: 16 } and no message gives 'Nexi refused the refund (code 16)'", async () => {
      const ko = signedKo({ codice: 16 });
      fetchMock().mockResolvedValueOnce(jsonResponse(ko));
      const result = await provider.refundPayment(CODE, 19.9);
      expect(result).toStrictEqual({
        success: false,
        verified: true,
        paymentId: 'SUB-0001-2026-12',
        status: 'REFUND_FAILED',
        error: 'Nexi refused the refund (code 16)',
        raw: ko,
      });
    });

    it.each([2, 3, 5, 13, 16])('a signed KO %i (a number other than 97 and 100) is an authenticated refusal', async (codice) => {
      const ko = signedKo({ codice, messaggio: '' });
      fetchMock().mockResolvedValueOnce(jsonResponse(ko));
      const result = await provider.refundPayment(CODE, 19.9);
      expect(result).toStrictEqual({
        success: false,
        verified: true,
        paymentId: 'SUB-0001-2026-12',
        status: 'REFUND_FAILED',
        error: `Nexi refused the refund (code ${codice})`,
        raw: ko,
      });
    });

    // Uncertain: success false, neither verified nor status (and no paymentId): the refund may exist
    const { mac: _okMac, ...unsignedOk } = OK_RESP;
    const { mac: _koMac, ...unsignedKo } = KO_17;
    const throwingJson = () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });
    it.each<[string, (mock: ReturnType<typeof vi.fn>) => void, string, unknown]>([
      [
        'a signed KO 97 (generic error)',
        (m) => m.mockResolvedValueOnce(jsonResponse(signedKo({ codice: 97, messaggio: 'Errore generico' }))),
        'Nexi refund outcome unknown (code 97)',
        signedKo({ codice: 97, messaggio: 'Errore generico' }),
      ],
      [
        'a signed KO 100 (internal error)',
        (m) => m.mockResolvedValueOnce(jsonResponse(signedKo({ codice: 100, messaggio: 'Errore interno' }))),
        'Nexi refund outcome unknown (code 100)',
        signedKo({ codice: 100, messaggio: 'Errore interno' }),
      ],
      [
        'a signed KO without errore',
        (m) => m.mockResolvedValueOnce(jsonResponse(signedKo())),
        'Nexi refund outcome unknown (code missing)',
        signedKo(),
      ],
      [
        'a signed KO whose errore has no codice',
        (m) => m.mockResolvedValueOnce(jsonResponse(signedKo({ messaggio: 'x' }))),
        'Nexi refund outcome unknown (code missing)',
        signedKo({ messaggio: 'x' }),
      ],
      [
        'a signed KO whose codice is not a number',
        (m) => m.mockResolvedValueOnce(jsonResponse(signedKo({ codice: '17', messaggio: 'x' }))),
        'Nexi refund outcome unknown (code 17)',
        signedKo({ codice: '17', messaggio: 'x' }),
      ],
      [
        'the KO without mac',
        (m) => m.mockResolvedValueOnce(jsonResponse(unsignedKo)),
        'Nexi refund outcome unknown (response MAC missing or invalid)',
        unsignedKo,
      ],
      [
        "OK_RESP with mac: 'deadbeef'",
        (m) => m.mockResolvedValueOnce(jsonResponse({ ...OK_RESP, mac: 'deadbeef' })),
        'Nexi refund outcome unknown (response MAC missing or invalid)',
        { ...OK_RESP, mac: 'deadbeef' },
      ],
      [
        'OK_RESP with a wrong 40-hex MAC',
        (m) => m.mockResolvedValueOnce(jsonResponse({ ...OK_RESP, mac: '3a8dbadc3faa3fe66c9f67f9d360da3039ce207a' })),
        'Nexi refund outcome unknown (response MAC missing or invalid)',
        { ...OK_RESP, mac: '3a8dbadc3faa3fe66c9f67f9d360da3039ce207a' },
      ],
      [
        'OK_RESP without mac',
        (m) => m.mockResolvedValueOnce(jsonResponse(unsignedOk)),
        'Nexi refund outcome unknown (response MAC missing or invalid)',
        unsignedOk,
      ],
      [
        "a validly signed answer whose esito is 'ANNULLO'",
        (m) => m.mockResolvedValueOnce(jsonResponse(signedAnswer('ANNULLO'))),
        'Nexi refund outcome unknown (esito ANNULLO)',
        signedAnswer('ANNULLO'),
      ],
      [
        'HTTP 500',
        (m) => m.mockResolvedValueOnce(jsonResponse({ detail: 'SECRET-BODY-CONTENT' }, 500)),
        'Nexi refund outcome unknown (HTTP 500)',
        undefined,
      ],
      [
        "fetch rejecting with new TypeError('fetch failed')",
        (m) => m.mockRejectedValueOnce(new TypeError('fetch failed')),
        'Nexi refund outcome unknown (network error)',
        undefined,
      ],
      [
        'json() throwing',
        (m) => m.mockResolvedValueOnce(throwingJson()),
        'Nexi refund outcome unknown (invalid response)',
        undefined,
      ],
      [
        'a 2xx JSON array',
        (m) => m.mockResolvedValueOnce(jsonResponse([OK_RESP])),
        'Nexi refund outcome unknown (invalid response)',
        undefined,
      ],
      [
        'a 2xx JSON null',
        (m) => m.mockResolvedValueOnce(jsonResponse(null)),
        'Nexi refund outcome unknown (invalid response)',
        undefined,
      ],
    ])('%s is uncertain: success false, with neither verified nor status', async (_label, answer, error, raw) => {
      answer(fetchMock());
      const result = await provider.refundPayment(CODE, 19.9);
      expect(fetchMock()).toHaveBeenCalledTimes(1);
      expect(result).toStrictEqual(raw === undefined ? { success: false, error } : { success: false, error, raw });
      expect(result).not.toHaveProperty('verified');
      expect(result).not.toHaveProperty('status');
      expect(result.error).not.toContain('SECRET-BODY-CONTENT');
    });
  });

  // ---------------------------------------------------------------------------
  // Full refund: importo is mandatory, so the order is read first
  // ---------------------------------------------------------------------------
  describe('full refund (amount omitted): situazioneOrdine first', () => {
    it.each([
      ['Contabilizzato', 'EUR'],
      ['Autorizzato', 'EUR'],
      ['Contabilizzato', '978'],
    ])('stato %s, divisa %s: reads the order, then refunds its amount', async (stato, divisa) => {
      fetchMock()
        .mockResolvedValueOnce(reportResponse([entry(stato, { divisa })]))
        .mockResolvedValueOnce(jsonResponse(OK_RESP));

      const result = await provider.refundPayment('SUB-0001-2026-12');

      expect(fetchMock()).toHaveBeenCalledTimes(2);
      expect(callUrl(0)).toBe(STATUS_URL);
      expect(callBody(0)).toStrictEqual({
        apiKey: 'ALIAS_TEST_01',
        codiceTransazione: 'SUB-0001-2026-12',
        timeStamp: '1767225600000',
        mac: '7676dedfa18d9bfe7390eda42e1d4942d823e8f5',
      });
      expect(callBody(0).mac).toBe(MAC_STATUS_REQUEST);
      expect(callUrl(1)).toBe(STORNA_URL);
      expect(callBody(1)).toStrictEqual({
        apiKey: 'ALIAS_TEST_01',
        codiceTransazione: 'SUB-0001-2026-12',
        importo: '1990',
        divisa: '978',
        timeStamp: '1767225600000',
        mac: 'a369be3e05d8e02bf2996b6980726f76e26a3dea',
      });
      expect(result).toStrictEqual({
        success: true,
        verified: true,
        paymentId: 'SUB-0001-2026-12',
        status: 'REFUNDED',
        raw: OK_RESP,
      });
    });

    it('the read is bounded by timeoutMs, the storno is not', async () => {
      fetchMock()
        .mockResolvedValueOnce(reportResponse([entry('Contabilizzato')]))
        .mockResolvedValueOnce(jsonResponse(OK_RESP));
      await provider.refundPayment(CODE);
      expect(callInit(0).signal).toBeInstanceOf(AbortSignal);
      expect(callInit(1).signal).toBeUndefined();
    });

    it("a string importo ('1990') is read like a number", async () => {
      fetchMock()
        .mockResolvedValueOnce(reportResponse([entry('Contabilizzato', { importo: '1990' })]))
        .mockResolvedValueOnce(jsonResponse(OK_RESP));
      await provider.refundPayment(CODE);
      expect(callBody(1)).toStrictEqual(STORNA_BODY_1990);
    });

    it('every entry for the code counts: a paid entry after a refused one is refunded in full', async () => {
      fetchMock()
        .mockResolvedValueOnce(reportResponse([entry('Negato'), entry('Contabilizzato')]))
        .mockResolvedValueOnce(jsonResponse(OK_RESP));
      const result = await provider.refundPayment(CODE);
      expect(fetchMock()).toHaveBeenCalledTimes(2);
      expect(callBody(1)).toStrictEqual(STORNA_BODY_1990);
      expect(result.success).toBe(true);
    });

    it('the storno answer is mapped as for a partial refund (a signed KO is a refusal)', async () => {
      fetchMock()
        .mockResolvedValueOnce(reportResponse([entry('Autorizzato')]))
        .mockResolvedValueOnce(jsonResponse(KO_17));
      expect(await provider.refundPayment(CODE)).toStrictEqual({
        success: false,
        verified: true,
        paymentId: 'SUB-0001-2026-12',
        status: 'REFUND_FAILED',
        error: 'Importo operazione troppo alto',
        raw: KO_17,
      });
    });

    it.each(['Rimborsato', 'Rimborsato Parz.', 'Contabilizzato Parz.', 'Negato', 'In Corso'])(
      'a read reporting %s refuses the full refund after exactly one request (no storno)',
      async (stato) => {
        fetchMock().mockResolvedValueOnce(reportResponse([entry(stato)]));
        const result = await provider.refundPayment(CODE);
        expect(fetchMock()).toHaveBeenCalledTimes(1);
        expect(callUrl(0)).toBe(STATUS_URL);
        // No verified, and no raw: the report can contain card data
        expect(result).toStrictEqual({
          success: false,
          status: 'REFUND_FAILED',
          error: `Nexi payment cannot be refunded in full (stato ${stato}): pass the amount; no refund was sent`,
        });
      },
    );

    it("a read reporting divisa 'GBP' refuses the full refund after exactly one request", async () => {
      fetchMock().mockResolvedValueOnce(reportResponse([entry('Contabilizzato', { divisa: 'GBP' })]));
      const result = await provider.refundPayment(CODE);
      expect(fetchMock()).toHaveBeenCalledTimes(1);
      expect(result).toStrictEqual({
        success: false,
        status: 'REFUND_FAILED',
        error: 'Nexi payment cannot be refunded in full (stato Contabilizzato): pass the amount; no refund was sent',
      });
    });

    it('a paid entry next to a refunded one is refused, with the refunded entry\'s stato in the message', async () => {
      fetchMock().mockResolvedValueOnce(reportResponse([entry('Autorizzato'), entry('Rimborsato')]));
      const result = await provider.refundPayment(CODE);
      expect(fetchMock()).toHaveBeenCalledTimes(1);
      expect(result).toStrictEqual({
        success: false,
        status: 'REFUND_FAILED',
        error: 'Nexi payment cannot be refunded in full (stato Rimborsato): pass the amount; no refund was sent',
      });
    });

    it.each([
      ['a missing stato', { codiceTransazione: CODE, importo: 1990, divisa: 'EUR' }, 'unknown'],
      ['a missing importo', { codiceTransazione: CODE, stato: 'Contabilizzato', divisa: 'EUR' }, 'Contabilizzato'],
      ['importo 0', entry(' Contabilizzato ', { importo: 0 }), 'Contabilizzato'],
    ])('%s refuses the full refund after exactly one request', async (_label, reported, shown) => {
      fetchMock().mockResolvedValueOnce(reportResponse([reported]));
      const result = await provider.refundPayment(CODE);
      expect(fetchMock()).toHaveBeenCalledTimes(1);
      expect(result).toStrictEqual({
        success: false,
        status: 'REFUND_FAILED',
        error: `Nexi payment cannot be refunded in full (stato ${shown}): pass the amount; no refund was sent`,
      });
    });

    it.each<[string, (mock: ReturnType<typeof vi.fn>) => void]>([
      ['a report without the code', (m) => m.mockResolvedValueOnce(reportResponse([{ ...entry('Contabilizzato'), codiceTransazione: 'SUB-0002-2026-12' }]))],
      ['the read answering HTTP 500', (m) => m.mockResolvedValueOnce(jsonResponse({}, 500))],
      [
        'the read answering an invalid MAC',
        (m) =>
          m.mockResolvedValueOnce(
            jsonResponse({ ...OK_RESP, mac: '3a8dbadc3faa3fe66c9f67f9d360da3039ce207a', report: [entry('Contabilizzato')] }),
          ),
      ],
      ['the read answering a signed KO 13', (m) => m.mockResolvedValueOnce(jsonResponse(signedKo({ codice: 13, messaggio: 'Ordine non trovato' })))],
      ['the read rejecting (network error)', (m) => m.mockRejectedValueOnce(new TypeError('fetch failed'))],
    ])('%s: the payment could not be read, after exactly one request', async (_label, answer) => {
      answer(fetchMock());
      const result = await provider.refundPayment(CODE);
      expect(fetchMock()).toHaveBeenCalledTimes(1);
      expect(callUrl(0)).toBe(STATUS_URL);
      expect(result).toStrictEqual({
        success: false,
        status: 'REFUND_FAILED',
        error: 'Nexi payment could not be read: no refund was sent',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Refused without any request
  // ---------------------------------------------------------------------------
  describe('refused without any request', () => {
    it('an amount of 1000000 (9 digits of cents) gives REFUND_FAILED; 999999.99 (8 digits) is sent', async () => {
      const tooLarge = await provider.refundPayment(CODE, 1000000);
      expect(tooLarge).toStrictEqual({
        success: false,
        status: 'REFUND_FAILED',
        error: 'Amount exceeds the Nexi limit (8 digits of cents): no refund was sent',
      });
      expect(fetchMock()).not.toHaveBeenCalled();

      fetchMock().mockResolvedValueOnce(jsonResponse(OK_RESP));
      await provider.refundPayment(CODE, 999999.99);
      expect(fetchMock()).toHaveBeenCalledTimes(1);
      expect(callBody(0).importo).toBe('99999999');
    });

    it.each([
      ['0', 0],
      ['null', null as unknown as number],
      ['-5', -5],
      ['19.999', 19.999],
      ['NaN', Number.NaN],
    ])("refundPayment(id, %s) keeps status 'FAILED', as in 2.2.0 (only an omitted amount is a full refund)", async (_label, amount) => {
      const result = await provider.refundPayment(CODE, amount);
      expect(result.success).toBe(false);
      expect(result.status).toBe('FAILED');
      expect(result.error).toMatch(/^Invalid amount /);
      expect(result).not.toHaveProperty('verified');
      expect(fetchMock()).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // refundApi: 'legacy' — the 2.2.0 request, byte for byte
  // ---------------------------------------------------------------------------
  describe("refundApi: 'legacy' (deprecated): the 2.2.0 request", () => {
    beforeEach(() => {
      provider = new NexiProvider({ ...baseConfig, refundApi: 'legacy' });
    });

    it('sends the 2.2.0 form POST to vas/igfs/storno/plain and maps { esito: OK } as in 2.2.0', async () => {
      fetchMock().mockResolvedValueOnce(jsonResponse({ esito: 'OK' }));
      const result = await provider.refundPayment('SUB-0001-2026-12', 19.9);

      expect(fetchMock()).toHaveBeenCalledTimes(1);
      expect(callUrl(0)).toBe('https://int-ecommerce.nexi.it/ecomm/api/vas/igfs/storno/plain');
      const init = callInit(0);
      expect(Object.keys(init)).toEqual(['method', 'headers', 'body']);
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
      expect(init.body).toBeInstanceOf(URLSearchParams);
      const body = init.body as URLSearchParams;
      expect([...body.entries()]).toEqual([
        ['alias', 'ALIAS_TEST_01'],
        ['codTrans', 'SUB-0001-2026-12'],
        ['importo', '1990'],
        ['timestamp', '2026-01-01T00:00:00.000Z'],
        ['mac', 'f66c1e3ac0f8d1e209034f0089b9be39fae7aef8'],
      ]);
      expect(String(body)).toBe(
        'alias=ALIAS_TEST_01&codTrans=SUB-0001-2026-12&importo=1990' +
          '&timestamp=2026-01-01T00%3A00%3A00.000Z&mac=f66c1e3ac0f8d1e209034f0089b9be39fae7aef8',
      );
      expect(body.get('mac')).toBe(MAC_LEGACY_1990);
      expect(result).toStrictEqual({
        success: true,
        paymentId: 'SUB-0001-2026-12',
        status: 'REFUNDED',
        raw: { esito: 'OK' },
      });
    });

    it('a full refund sends importo= and its MAC, with no read', async () => {
      fetchMock().mockResolvedValueOnce(jsonResponse({ esito: 'OK' }));
      const result = await provider.refundPayment('SUB-0001-2026-12');
      expect(fetchMock()).toHaveBeenCalledTimes(1);
      expect(callUrl(0)).toBe(LEGACY_URL);
      const body = callInit(0).body as URLSearchParams;
      expect(body.get('importo')).toBe('');
      expect(body.get('mac')).toBe('3d91e5853fa6602bbdf775af3fab6dba3709ea68');
      expect(body.get('mac')).toBe(MAC_LEGACY_FULL);
      expect(result).toStrictEqual({ success: true, paymentId: CODE, status: 'REFUNDED', raw: { esito: 'OK' } });
    });

    it('keeps the 2.2.0 result mapping: any esito other than OK, HTTP and network errors, non-JSON', async () => {
      fetchMock().mockResolvedValueOnce(jsonResponse({ esito: 'KO' }));
      expect(await provider.refundPayment(CODE, 19.9)).toStrictEqual({
        success: false,
        paymentId: CODE,
        status: 'REFUND_FAILED',
        raw: { esito: 'KO' },
      });

      // A 2.2.0 OK is a success with or without a MAC: legacy never checks one
      fetchMock().mockResolvedValueOnce(jsonResponse({ ...OK_RESP, mac: 'deadbeef' }));
      expect(await provider.refundPayment(CODE, 19.9)).toMatchObject({ success: true, status: 'REFUNDED' });

      fetchMock().mockResolvedValueOnce(jsonResponse({}, 500));
      expect(await provider.refundPayment(CODE, 19.9)).toStrictEqual({ success: false, error: 'Nexi API error: HTTP 500' });

      fetchMock().mockRejectedValueOnce(new Error('Network failure'));
      expect(await provider.refundPayment(CODE, 19.9)).toStrictEqual({ success: false, error: 'Network failure' });

      fetchMock().mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
      expect(await provider.refundPayment(CODE, 19.9)).toStrictEqual({ success: false, error: 'Invalid provider response' });

      expect(fetchMock().mock.calls.map((c) => String(c[0]))).toEqual(Array(5).fill(LEGACY_URL));
    });

    it("an invalid amount keeps status 'FAILED' without any request", async () => {
      const result = await provider.refundPayment(CODE, 0);
      expect(result.success).toBe(false);
      expect(result.status).toBe('FAILED');
      expect(fetchMock()).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  describe('config', () => {
    it.each([['storno'], ['STORNA'], ['Legacy'], [''], [null], [true], [1]])(
      'refundApi %j throws a TypeError in the constructor',
      (value) => {
        expect(() => new NexiProvider({ ...baseConfig, refundApi: value as never })).toThrow(TypeError);
        expect(() => new NexiProvider({ ...baseConfig, refundApi: value as never })).toThrow(
          "Invalid NexiProviderConfig.refundApi: expected 'storna' or 'legacy'",
        );
      },
    );

    it("new NexiProvider({ ...baseConfig, refundApi: 'storno' as never }) throws a TypeError", () => {
      expect(() => new NexiProvider({ ...baseConfig, refundApi: 'storno' as never })).toThrow(TypeError);
    });

    it("refundApi: undefined is the default ('storna'); 'storna' and 'legacy' are accepted", () => {
      expect(() => new NexiProvider({ ...baseConfig, refundApi: undefined })).not.toThrow();
      expect(() => new NexiProvider({ ...baseConfig, refundApi: 'storna' })).not.toThrow();
      expect(() => new NexiProvider({ ...baseConfig, refundApi: 'legacy' })).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Unchanged: the key and options checks come first, with both APIs (#44)
  // ---------------------------------------------------------------------------
  describe.each([
    ['the default', {}],
    ["'storna'", { refundApi: 'storna' as const }],
    ["'legacy'", { refundApi: 'legacy' as const }],
  ])('key and options checks with refundApi %s (unchanged, #44)', (_label, extra) => {
    beforeEach(() => {
      provider = new NexiProvider({ ...baseConfig, ...extra });
    });

    it('an idempotency key, called directly, is refused without any request', async () => {
      expect((provider as { supportsRefundIdempotency?: unknown }).supportsRefundIdempotency).not.toBe(true);
      const result = await provider.refundPayment('SUB-0001-2026-12', 19.9, { idempotencyKey: 'refund-SUB-0001-R1' });
      expect(result).toEqual({
        success: false,
        status: 'REFUND_FAILED',
        error: 'Nexi refunds do not support an idempotency key',
      });
      expect(fetchMock()).not.toHaveBeenCalled();
    });

    it('any key, or options of another shape, are refused without any request', async () => {
      for (const idempotencyKey of ['short', 123 as unknown as string]) {
        expect(await provider.refundPayment('SUB-0001-2026-12', 19.9, { idempotencyKey })).toEqual({
          success: false,
          status: 'REFUND_FAILED',
          error: 'Nexi refunds do not support an idempotency key',
        });
      }
      for (const options of ['duplicate', 42, [], { idempotencyKy: 'refund-SUB-0001-R1' }, { reason: 'duplicate' }]) {
        expect(await provider.refundPayment('SUB-0001-2026-12', 19.9, options)).toEqual({
          success: false,
          status: 'REFUND_FAILED',
          error: 'Invalid refund options',
        });
      }
      // A full refund is refused before its read, too
      expect(await provider.refundPayment('SUB-0001-2026-12', undefined, { idempotencyKey: 'refund-SUB-0001-R1' })).toEqual({
        success: false,
        status: 'REFUND_FAILED',
        error: 'Nexi refunds do not support an idempotency key',
      });
      expect(fetchMock()).not.toHaveBeenCalled();
    });

    it('through the configurator, a key is refused with REFUND_IDEMPOTENCY_NOT_SUPPORTED, without a request or an event', async () => {
      const checkout = new CheckoutConfigurator().registerProvider(provider);
      const events: CheckoutEventPayload[] = [];
      checkout.events.on('payment.refunded', (payload) => {
        events.push(payload);
      });
      let thrown: unknown;
      try {
        await checkout.refundPayment('nexi', CODE, 19.9, { idempotencyKey: 'refund-SUB-0001-R1' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CheckoutError);
      expect((thrown as CheckoutError).code).toBe('REFUND_IDEMPOTENCY_NOT_SUPPORTED');
      expect(fetchMock()).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Through the configurator: payment.refunded
  // ---------------------------------------------------------------------------
  describe('through the configurator', () => {
    function configured() {
      const checkout = new CheckoutConfigurator().registerProvider(provider);
      const events: CheckoutEventPayload[] = [];
      checkout.events.on('payment.refunded', (payload) => {
        events.push(payload);
      });
      return { checkout, events };
    }

    it("checkout.refundPayment('nexi', 'SUB-0001-2026-12', 19.9) with a signed OK emits payment.refunded with verified: true", async () => {
      const { checkout, events } = configured();
      fetchMock().mockResolvedValueOnce(jsonResponse(OK_RESP));
      const result = await checkout.refundPayment('nexi', 'SUB-0001-2026-12', 19.9);
      expect(result).toMatchObject({ success: true, verified: true, status: 'REFUNDED' });
      expect(callBody(0)).toStrictEqual(STORNA_BODY_1990);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        provider: 'nexi',
        paymentId: 'SUB-0001-2026-12',
        status: 'REFUNDED',
        verified: true,
      });
    });

    it('a signed refusal emits verified: true with REFUND_FAILED; an unknown outcome verified: false and no status', async () => {
      const { checkout, events } = configured();
      fetchMock().mockResolvedValueOnce(jsonResponse(KO_17)).mockResolvedValueOnce(jsonResponse({}, 503));
      await checkout.refundPayment('nexi', CODE, 19.9);
      await checkout.refundPayment('nexi', CODE, 19.9);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ status: 'REFUND_FAILED', verified: true, error: 'Importo operazione troppo alto' });
      expect(events[1]).toMatchObject({ verified: false, error: 'Nexi refund outcome unknown (HTTP 503)' });
      expect(events[1].status).toBeUndefined();
    });

    it("with refundApi: 'legacy', a 2.2.0 OK emits payment.refunded with verified: false, as in 2.2.0", async () => {
      provider = new NexiProvider({ ...baseConfig, refundApi: 'legacy' });
      const { checkout, events } = configured();
      fetchMock().mockResolvedValueOnce(jsonResponse({ esito: 'OK' }));
      await checkout.refundPayment('nexi', CODE, 19.9);
      expect(callUrl(0)).toBe(LEGACY_URL);
      expect(events[0]).toMatchObject({ status: 'REFUNDED', verified: false });
    });
  });
});
