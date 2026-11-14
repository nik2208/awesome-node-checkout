import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { NexiProvider, NexiProviderConfig } from './nexi.provider';
import { CheckoutConfigurator } from '../../checkout-configurator';
import { CheckoutEventName, CheckoutEventPayload } from '../../events/checkout-event-bus';
import { isMandateProvider } from '../../interfaces/mandate-provider.interface';
import { createCheckoutRouter } from '../../adapters/express';
import type { CheckoutConfig } from '../../models/checkout-config.model';
import { Mandate, MandatePendingState, MandateSetupRequest } from '../../models/mandate.model';

// Recurring payments (mandates) on Nexi XPay, issue #31.
// Every MAC below is a literal computed independently of the implementation (issue #31,
// "Test vectors"): the tests never compare against the provider's own helpers.

const MERCHANT_ID = 'ALIAS_TEST_01';
const MAC_KEY = 'TEST_SECRET_KEY_0001';
const NOW = 1767225600000;

const MAC_SETUP = 'ea1f188b47f63e76234075c60d3185e45f197874';
const MAC_SETUP_S = 'b85222313352bd9d618e9828e4beb73e5200ddf8';
const MAC_OUTCOME_OK = 'b30009179e6be7f2af68aebff7182845e2acf905';
const MAC_OUTCOME_OTHER_CODTRANS = '2e6c5a13e7ea88cfe68ea1297e41356c7d997d7f';
const MAC_OUTCOME_IMPORTO_100 = 'b32f36da8c2163b3c206ac57f815e9e48100e92f';
const MAC_OUTCOME_KO = 'f7eeec5816848954885a5843445723677977db96';
const MAC_CHARGE = 'c7f22774f25738eb5283df704e658ba98ba0a9e5';
const MAC_API_RESPONSE_OK = '2a8dbadc3faa3fe66c9f67f9d360da3039ce207a';
const MAC_CANCEL = 'ef8699b39d42f5e2cacd6b5b13b0f319b281f330';
const MAC_DETAILS = '69237bb9072ccbae03137a7b7e5ef5def8a00055';

const OK_RESP = { esito: 'OK', idOperazione: '123456789', timeStamp: '1767225601000', mac: MAC_API_RESPONSE_OK };

const MANDATE_REF = 'MNDT0000000001';
const ORDER_ID = 'SUB-0001-INIT';
const CHARGE_REF = 'SUB-0001-2026-12';
const CALLBACK = 'https://app.test/checkout/nexi/mandate/callback';

const PAID_ENTRY = { codiceTransazione: CHARGE_REF, stato: 'Autorizzato', importo: 1990, divisa: 'EUR' };

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

/** Fixture input only (no literal vector for these esito values): never asserted. */
function signedOutcome(esito: string, codAut = ''): Record<string, string> {
  const mac = crypto
    .createHash('sha1')
    .update(
      `codTrans=${ORDER_ID}esito=${esito}importo=1990divisa=EURdata=20261201orario=101500codAut=${codAut}${MAC_KEY}`,
    )
    .digest('hex');
  return { ...okOutcome(), esito, codAut, mac };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function setupRequest(overrides: Partial<MandateSetupRequest> = {}): MandateSetupRequest {
  return {
    mandateRef: MANDATE_REF,
    orderId: ORDER_ID,
    amount: 19.9,
    currency: 'EUR',
    description: 'Pro plan',
    returnUrl: CALLBACK,
    cancelUrl: CALLBACK,
    ...overrides,
  };
}

function pendingState(): MandatePendingState {
  return {
    provider: 'nexi',
    mandateRef: MANDATE_REF,
    orderId: ORDER_ID,
    amount: 19.9,
    currency: 'EUR',
    providerRef: ORDER_ID,
    createdAt: new Date(NOW).toISOString(),
  };
}

function mandate(): Mandate {
  return {
    provider: 'nexi',
    mandateRef: MANDATE_REF,
    providerMandateId: MANDATE_REF,
    status: 'active',
    createdAt: new Date(NOW).toISOString(),
  };
}

/** The genuine OK outcome of the setup, as Nexi appends it to `url` (plus mandate_ref). */
function okOutcome(): Record<string, string> {
  return {
    mandate_ref: MANDATE_REF,
    codTrans: ORDER_ID,
    esito: 'OK',
    importo: '1990',
    divisa: 'EUR',
    data: '20261201',
    orario: '101500',
    codAut: 'AB1234',
    mac: MAC_OUTCOME_OK,
    num_contratto: MANDATE_REF,
    scadenza_pan: '203012',
  };
}

function fetchMock() {
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}

function callUrl(i: number): string {
  return String(fetchMock().mock.calls[i][0]);
}

function callBody(i: number): Record<string, unknown> {
  return JSON.parse(String((fetchMock().mock.calls[i][1] as RequestInit).body));
}

describe('NexiProvider mandates (#31)', () => {
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

  it('implements IMandateProvider', () => {
    expect(isMandateProvider(provider)).toBe(true);
    expect(new CheckoutConfigurator({ emitEvents: false }).registerProvider(provider).supportsMandates('nexi')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // AC 1 — createMandate
  // ---------------------------------------------------------------------------
  describe('createMandate (AC 1)', () => {
    it('builds the paga_multi / PP first-payment URL with the setup MAC', async () => {
      const start = await provider.createMandate(setupRequest());
      expect(start.success).toBe(true);
      const url = new URL(start.approvalUrl!);
      expect(`${url.origin}${url.pathname}`).toBe('https://int-ecommerce.nexi.it/ecomm/ecomm/DispatcherServlet');
      const q = url.searchParams;
      expect(q.get('mac')).toBe('ea1f188b47f63e76234075c60d3185e45f197874');
      expect(q.get('num_contratto')).toBe('MNDT0000000001');
      expect(q.get('tipo_servizio')).toBe('paga_multi');
      expect(q.get('tipo_richiesta')).toBe('PP');
      expect(q.get('importo')).toBe('1990');
      expect(q.get('divisa')).toBe('EUR');
      expect(q.get('codTrans')).toBe('SUB-0001-INIT');
      expect(q.get('alias')).toBe('ALIAS_TEST_01');
      expect(q.has('tipo_contratto')).toBe(false);
      expect(q.has('urlpost')).toBe(false);
      expect(q.has('gruppo')).toBe(false);
      expect(q.get('url')).toContain('mandate_ref=MNDT0000000001');
      expect(q.get('url_back')).toContain('mandate_ref=MNDT0000000001');
      expect(start.approvalUrl).toContain(`mac=${MAC_SETUP}`);
    });

    it('returns the pending state to persist', async () => {
      const start = await provider.createMandate(setupRequest());
      expect(start.pending).toEqual({
        provider: 'nexi',
        mandateRef: 'MNDT0000000001',
        orderId: 'SUB-0001-INIT',
        amount: 19.9,
        currency: 'EUR',
        providerRef: 'SUB-0001-INIT',
        createdAt: new Date(NOW).toISOString(),
      });
      expect(start.pending!.providerRef).toBe('SUB-0001-INIT');
    });

    it("with contractType 'S' sends tipo_contratto and includes it in the MAC", async () => {
      provider = new NexiProvider({ ...baseConfig, contractType: 'S' });
      const start = await provider.createMandate(setupRequest());
      const q = new URL(start.approvalUrl!).searchParams;
      expect(q.get('tipo_contratto')).toBe('S');
      expect(q.get('mac')).toBe('b85222313352bd9d618e9828e4beb73e5200ddf8');
      expect(start.approvalUrl).toContain(`mac=${MAC_SETUP_S}`);
    });

    it('appends mandate_ref to urlpost and sends gruppo when configured', async () => {
      provider = new NexiProvider({ ...baseConfig, group: 'GRP01' });
      const start = await provider.createMandate(setupRequest({ notifyUrl: `${CALLBACK}?src=urlpost` }));
      const q = new URL(start.approvalUrl!).searchParams;
      expect(q.get('urlpost')).toBe(`${CALLBACK}?src=urlpost&mandate_ref=MNDT0000000001`);
      expect(q.get('gruppo')).toBe('GRP01');
      // gruppo is not part of the setup MAC
      expect(q.get('mac')).toBe(MAC_SETUP);
    });

    it('rejects currencies other than EUR', async () => {
      const start = await provider.createMandate(setupRequest({ currency: 'USD' }));
      expect(start.success).toBe(false);
      expect(start.error).toBe('Nexi mandates support EUR only');
      expect(start.approvalUrl).toBeUndefined();
    });

    it('returns success: false (never throws) for an invalid amount or URL when called directly', async () => {
      expect((await provider.createMandate(setupRequest({ amount: 19.999 }))).success).toBe(false);
      expect((await provider.createMandate(setupRequest({ returnUrl: '/relative' }))).success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // AC 2 — confirmMandate, OK path
  // ---------------------------------------------------------------------------
  describe('confirmMandate, OK path (AC 2)', () => {
    it('activates the mandate and reports the first charge as succeeded', async () => {
      const outcome = await provider.confirmMandate(pendingState(), { query: okOutcome() });
      expect(outcome.success).toBe(true);
      expect(outcome.verified).toBe(true);
      expect(outcome.terminal).toBe(true);
      expect(outcome.mandate!.providerMandateId).toBe('MNDT0000000001');
      expect(outcome.mandate!.mandateRef).toBe('MNDT0000000001');
      expect(outcome.mandate!.provider).toBe('nexi');
      expect(outcome.mandate!.status).toBe('active');
      expect(outcome.mandate!.unverified!.cardExpiry).toBe('203012');
      expect(outcome.firstCharge.status).toBe('succeeded');
      expect(outcome.firstCharge.chargeRef).toBe('SUB-0001-INIT');
      expect(outcome.firstCharge).toMatchObject({
        verified: true,
        providerPaymentId: 'SUB-0001-INIT',
        amount: 19.9,
        currency: 'EUR',
      });
    });

    it('is idempotent: two calls give deep-equal results apart from createdAt', async () => {
      const first = await provider.confirmMandate(pendingState(), { query: okOutcome() });
      vi.setSystemTime(NOW + 5000);
      const second = await provider.confirmMandate(pendingState(), { query: okOutcome() });
      const strip = (o: typeof first) => ({ ...o, mandate: { ...o.mandate!, createdAt: undefined } });
      expect(strip(second)).toEqual(strip(first));
      expect(fetchMock()).not.toHaveBeenCalled();
    });

    it('accepts the urlpost form POST (fields in the body)', async () => {
      const { mandate_ref, ...form } = okOutcome();
      const outcome = await provider.confirmMandate(pendingState(), { query: { mandate_ref }, body: form });
      expect(outcome.success).toBe(true);
      expect(outcome.terminal).toBe(true);
    });

    it('takes the masked PAN hint only when well-formed', async () => {
      const ok = await provider.confirmMandate(pendingState(), { query: { ...okOutcome(), pan: '453997******0006' } });
      expect(ok.mandate!.unverified!.maskedPan).toBe('453997******0006');
      const bad = await provider.confirmMandate(pendingState(), {
        query: { ...okOutcome(), pan: '<script>', scadenza_pan: '2030-12' },
      });
      expect(bad.mandate!.unverified).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // AC 3 — confirmMandate, failures
  // ---------------------------------------------------------------------------
  describe('confirmMandate, failures (AC 3)', () => {
    const expectNonTerminal = (outcome: Awaited<ReturnType<NexiProvider['confirmMandate']>>) => {
      expect(outcome.success).toBe(false);
      expect(outcome.mandate).toBeUndefined();
      expect(outcome.verified).toBe(false);
      expect(outcome.terminal).toBe(false);
      expect(outcome.firstCharge.status).toBe('unknown');
      expect(outcome.firstCharge.chargeRef).toBe('SUB-0001-INIT');
    };

    it('(a) a MAC altered by one character is unverified and non-terminal', async () => {
      const mac = MAC_OUTCOME_OK.slice(0, -1) + (MAC_OUTCOME_OK.endsWith('5') ? '6' : '5');
      const outcome = await provider.confirmMandate(pendingState(), { query: { ...okOutcome(), mac } });
      expectNonTerminal(outcome);
      expect(outcome.firstCharge.error).toBe('Invalid outcome MAC');
    });

    it('(b) num_contratto of another contract, with the valid MAC, is rejected', async () => {
      const outcome = await provider.confirmMandate(pendingState(), {
        query: { ...okOutcome(), num_contratto: 'OTHER000001' },
      });
      expectNonTerminal(outcome);
      expect(outcome.error).toBe('Outcome does not match the pending setup');
    });

    it('(c) the outcome of another codTrans, with its valid MAC, is rejected', async () => {
      const outcome = await provider.confirmMandate(pendingState(), {
        query: { ...okOutcome(), codTrans: 'SUB-0002-INIT', mac: MAC_OUTCOME_OTHER_CODTRANS },
      });
      expectNonTerminal(outcome);
      expect(outcome.error).toBe('Outcome does not match the pending setup');
    });

    it('(d) an outcome with importo=100, with its valid MAC, is rejected', async () => {
      const outcome = await provider.confirmMandate(pendingState(), {
        query: { ...okOutcome(), importo: '100', mac: MAC_OUTCOME_IMPORTO_100 },
      });
      expectNonTerminal(outcome);
      expect(outcome.error).toBe('Outcome amount does not match');
    });

    it('(e) the KO outcome, with its valid MAC, is a verified terminal refusal', async () => {
      const outcome = await provider.confirmMandate(pendingState(), {
        query: {
          ...okOutcome(),
          esito: 'KO',
          codAut: '',
          mac: MAC_OUTCOME_KO,
          messaggio: 'Auth. Denied',
          codiceEsito: '102',
        },
      });
      expect(outcome.success).toBe(false);
      expect(outcome.mandate).toBeUndefined();
      expect(outcome.verified).toBe(true);
      expect(outcome.terminal).toBe(true);
      expect(outcome.firstCharge).toMatchObject({
        status: 'failed',
        verified: true,
        chargeRef: 'SUB-0001-INIT',
        error: 'Auth. Denied',
        providerCode: '102',
      });
    });

    it('the KO outcome without messaggio reports the esito as error', async () => {
      const { scadenza_pan, ...rest } = okOutcome();
      const outcome = await provider.confirmMandate(pendingState(), {
        query: { ...rest, esito: 'KO', codAut: '', mac: MAC_OUTCOME_KO },
      });
      expect(outcome.firstCharge.error).toBe('KO');
    });

    it('ANNULLO and ERRORE, with a valid MAC, are verified terminal refusals', async () => {
      for (const esito of ['ANNULLO', 'ERRORE']) {
        const outcome = await provider.confirmMandate(pendingState(), { query: signedOutcome(esito) });
        expect(outcome.success).toBe(false);
        expect(outcome.verified).toBe(true);
        expect(outcome.terminal).toBe(true);
        expect(outcome.firstCharge.status).toBe('failed');
      }
    });

    it('an unrecognised esito (e.g. PEN, pending), with a valid MAC, is non-terminal', async () => {
      const outcome = await provider.confirmMandate(pendingState(), { query: signedOutcome('PEN') });
      expectNonTerminal(outcome);
      expect(outcome.error).toBe('Mandate setup outcome PEN is not final');
    });

    it('an OK outcome without num_contratto, with the valid MAC, is non-terminal', async () => {
      const { num_contratto, ...rest } = okOutcome();
      const outcome = await provider.confirmMandate(pendingState(), { query: rest });
      expectNonTerminal(outcome);
      expect(outcome.error).toBe('Outcome does not match the pending setup');
    });

    it('tipo_servizio / tipo_richiesta other than paga_multi / PP are rejected; the expected ones pass', async () => {
      for (const extra of [{ tipo_servizio: 'paga_oc3d' }, { tipo_richiesta: 'PR' }]) {
        const outcome = await provider.confirmMandate(pendingState(), { query: { ...okOutcome(), ...extra } });
        expectNonTerminal(outcome);
        expect(outcome.error).toBe('Outcome does not match the pending setup');
      }
      const ok = await provider.confirmMandate(pendingState(), {
        query: { ...okOutcome(), tipo_servizio: 'paga_multi', tipo_richiesta: 'PP' },
      });
      expect(ok.success).toBe(true);
      expect(ok.terminal).toBe(true);
    });

    it('an empty input (re-confirm job) is unverified and non-terminal', async () => {
      expectNonTerminal(await provider.confirmMandate(pendingState(), {}));
    });
  });

  // ---------------------------------------------------------------------------
  // AC 4 — chargeMandate, success
  // ---------------------------------------------------------------------------
  describe('chargeMandate, success (AC 4)', () => {
    it('checks situazioneOrdine, then posts pagamentoRicorrente with the recurring MAC', async () => {
      fetchMock()
        .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [] }))
        .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, codiceAutorizzazione: 'X1' }));

      const result = await provider.chargeMandate(mandate(), { chargeRef: CHARGE_REF, amount: 19.9, currency: 'EUR' });

      expect(fetchMock()).toHaveBeenCalledTimes(2);
      expect(callUrl(0)).toBe('https://int-ecommerce.nexi.it/ecomm/api/bo/situazioneOrdine');
      expect(callBody(0)).toMatchObject({ apiKey: 'ALIAS_TEST_01', codiceTransazione: 'SUB-0001-2026-12' });
      expect(callUrl(1)).toBe('https://int-ecommerce.nexi.it/ecomm/api/recurring/pagamentoRicorrente');
      const body = callBody(1);
      expect(body).toEqual({
        apiKey: 'ALIAS_TEST_01',
        numeroContratto: 'MNDT0000000001',
        codiceTransazione: 'SUB-0001-2026-12',
        importo: '1990',
        divisa: '978',
        timeStamp: '1767225600000',
        mac: 'c7f22774f25738eb5283df704e658ba98ba0a9e5',
      });
      expect('scadenza' in body).toBe(false);

      expect(result.status).toBe('succeeded');
      expect(result.verified).toBe(true);
      expect(result.providerPaymentId).toBe('SUB-0001-2026-12');
      expect(result.chargeRef).toBe('SUB-0001-2026-12');
      expect(result.amount).toBeUndefined();
      expect(result.currency).toBeUndefined();
      expect((result.raw as Record<string, unknown>).codiceAutorizzazione).toBe('X1');
    });

    it('passes a timeout signal to every API call', async () => {
      fetchMock()
        .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [] }))
        .mockResolvedValueOnce(jsonResponse({ ...OK_RESP }));
      await provider.chargeMandate(mandate(), { chargeRef: CHARGE_REF, amount: 19.9, currency: 'EUR' });
      for (const call of fetchMock().mock.calls) {
        expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
      }
    });

    it('exposes a well-formed dettagliCarta.expiry as raw.cardExpiry', async () => {
      fetchMock()
        .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [] }))
        .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, dettagliCarta: { expiry: '203112', maskedPan: '4539********0006' } }));
      const result = await provider.chargeMandate(mandate(), { chargeRef: CHARGE_REF, amount: 19.9, currency: 'EUR' });
      expect((result.raw as Record<string, unknown>).cardExpiry).toBe('203112');
    });

    it('adds codiceGruppo to the body without changing the MAC', async () => {
      provider = new NexiProvider({ ...baseConfig, group: 'GRP01' });
      fetchMock()
        .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [] }))
        .mockResolvedValueOnce(jsonResponse({ ...OK_RESP }));
      await provider.chargeMandate(mandate(), { chargeRef: CHARGE_REF, amount: 19.9, currency: 'EUR' });
      expect(callBody(1).codiceGruppo).toBe('GRP01');
      expect(callBody(1).mac).toBe(MAC_CHARGE);
    });
  });

  // ---------------------------------------------------------------------------
  // AC 5 — chargeMandate, other outcomes
  // ---------------------------------------------------------------------------
  describe('chargeMandate, other outcomes (AC 5)', () => {
    const charge = { chargeRef: CHARGE_REF, amount: 19.9, currency: 'EUR' };
    const emptyLookup = () => jsonResponse({ ...OK_RESP, report: [] });
    const ko = (codice: number, messaggio = 'error') => jsonResponse({ esito: 'KO', errore: { codice, messaggio } });

    it('(a) an altered response MAC is unknown', async () => {
      fetchMock()
        .mockResolvedValueOnce(emptyLookup())
        .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, mac: MAC_API_RESPONSE_OK.replace(/^2/, '3') }));
      const result = await provider.chargeMandate(mandate(), charge);
      expect(result.status).toBe('unknown');
      expect(result.error).toBe('Response MAC mismatch');
    });

    it('an OK response without a MAC is unknown', async () => {
      const { mac, ...unsigned } = OK_RESP;
      fetchMock().mockResolvedValueOnce(emptyLookup()).mockResolvedValueOnce(jsonResponse(unsigned));
      expect((await provider.chargeMandate(mandate(), charge)).status).toBe('unknown');
    });

    it('(b) KO 19 is an authoritative refusal', async () => {
      fetchMock().mockResolvedValueOnce(emptyLookup()).mockResolvedValueOnce(ko(19, 'Auth. Denied'));
      const result = await provider.chargeMandate(mandate(), charge);
      expect(result.status).toBe('failed');
      expect(result.verified).toBe(true);
      expect(result.providerCode).toBe('19');
      expect(result.error).toBe('Auth. Denied');
      expect(result.mandateUnusable).toBeFalsy();
    });

    it('(c) KO 14 and KO 8 mark the mandate unusable', async () => {
      for (const codice of [14, 8]) {
        fetchMock().mockReset();
        fetchMock().mockResolvedValueOnce(emptyLookup()).mockResolvedValueOnce(ko(codice));
        const result = await provider.chargeMandate(mandate(), charge);
        expect(result.status).toBe('failed');
        expect(result.verified).toBe(true);
        expect(result.mandateUnusable).toBe(true);
        expect(result.providerCode).toBe(String(codice));
      }
    });

    it('(d) KO 3 (wrong MAC) and KO 99 (merchant not enabled) are unknown', async () => {
      for (const codice of [3, 99]) {
        fetchMock().mockReset();
        fetchMock().mockResolvedValueOnce(emptyLookup()).mockResolvedValueOnce(ko(codice));
        const result = await provider.chargeMandate(mandate(), charge);
        expect(result.status).toBe('unknown');
        expect(result.providerCode).toBe(String(codice));
      }
    });

    it('a KO without a numeric error code is unknown, never failed', async () => {
      for (const body of [{ esito: 'KO' }, { esito: 'KO', errore: { codice: 'x', messaggio: 'm' } }]) {
        fetchMock().mockReset();
        fetchMock().mockResolvedValueOnce(emptyLookup()).mockResolvedValueOnce(jsonResponse(body));
        const result = await provider.chargeMandate(mandate(), charge);
        expect(result.status).toBe('unknown');
        expect(result.verified).toBe(false);
      }
    });

    it('a KO whose MAC is present but wrong is unknown', async () => {
      fetchMock()
        .mockResolvedValueOnce(emptyLookup())
        .mockResolvedValueOnce(jsonResponse({ ...signedKo(19), mac: MAC_API_RESPONSE_OK }));
      expect((await provider.chargeMandate(mandate(), charge)).status).toBe('unknown');
    });

    it('(e) KO 9 is re-read: paid is succeeded, absent is unknown', async () => {
      fetchMock()
        .mockResolvedValueOnce(emptyLookup())
        .mockResolvedValueOnce(ko(9, 'Transazione già presente'))
        .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [PAID_ENTRY] }));
      const paid = await provider.chargeMandate(mandate(), charge);
      expect(fetchMock()).toHaveBeenCalledTimes(3);
      expect(callUrl(2)).toBe('https://int-ecommerce.nexi.it/ecomm/api/bo/situazioneOrdine');
      expect(paid.status).toBe('succeeded');
      expect(paid.verified).toBe(true);
      expect(paid.providerPaymentId).toBe('SUB-0001-2026-12');

      fetchMock().mockReset();
      fetchMock()
        .mockResolvedValueOnce(emptyLookup())
        .mockResolvedValueOnce(ko(9))
        .mockResolvedValueOnce(emptyLookup());
      expect((await provider.chargeMandate(mandate(), charge)).status).toBe('unknown');
    });

    it('(f) an AbortError, HTTP 503 and HTTP 401 are unknown, without the body in error', async () => {
      const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      fetchMock().mockResolvedValueOnce(emptyLookup()).mockRejectedValueOnce(abort);
      expect((await provider.chargeMandate(mandate(), charge)).status).toBe('unknown');

      for (const status of [503, 401]) {
        fetchMock().mockReset();
        fetchMock()
          .mockResolvedValueOnce(emptyLookup())
          .mockResolvedValueOnce(jsonResponse({ detail: 'SECRET-BODY-CONTENT' }, status));
        const result = await provider.chargeMandate(mandate(), charge);
        expect(result.status).toBe('unknown');
        expect(result.verified).toBe(false);
        expect(result.error ?? '').not.toContain('SECRET-BODY-CONTENT');
      }
    });

    it('a timeout or a non-JSON body is unknown', async () => {
      const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      fetchMock().mockResolvedValueOnce(emptyLookup()).mockRejectedValueOnce(timeout);
      expect((await provider.chargeMandate(mandate(), charge)).status).toBe('unknown');

      fetchMock().mockReset();
      fetchMock()
        .mockResolvedValueOnce(emptyLookup())
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
      const result = await provider.chargeMandate(mandate(), charge);
      expect(result.status).toBe('unknown');
      expect(result.error).toBe('Invalid provider response');
    });

    it('(g) an already paid chargeRef is succeeded and pagamentoRicorrente is never called', async () => {
      fetchMock().mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [PAID_ENTRY] }));
      const result = await provider.chargeMandate(mandate(), charge);
      expect(result.status).toBe('succeeded');
      expect(result.verified).toBe(true);
      expect(result.providerPaymentId).toBe('SUB-0001-2026-12');
      expect(result.amount).toBe(19.9);
      expect(result.currency).toBe('EUR');
      expect(fetchMock()).toHaveBeenCalledTimes(1);
      expect(fetchMock().mock.calls.map((c) => String(c[0]))).not.toContain(
        'https://int-ecommerce.nexi.it/ecomm/api/recurring/pagamentoRicorrente',
      );
    });

    it('a paid entry after an unpaid one for the same chargeRef is succeeded and not charged again', async () => {
      fetchMock().mockResolvedValueOnce(
        jsonResponse({ ...OK_RESP, report: [{ ...PAID_ENTRY, stato: 'Negato' }, PAID_ENTRY] }),
      );
      const result = await provider.chargeMandate(mandate(), charge);
      expect(result.status).toBe('succeeded');
      expect(result.verified).toBe(true);
      expect(result.providerPaymentId).toBe('SUB-0001-2026-12');
      expect(fetchMock()).toHaveBeenCalledTimes(1);
    });

    it('an existing unpaid chargeRef is failed and not charged again', async () => {
      fetchMock().mockResolvedValueOnce(
        jsonResponse({ ...OK_RESP, report: [{ ...PAID_ENTRY, stato: 'Negato' }] }),
      );
      const result = await provider.chargeMandate(mandate(), charge);
      expect(result.status).toBe('failed');
      expect(result.verified).toBe(true);
      expect(result.error).toBe('A transaction with this chargeRef already exists: Negato');
      expect(fetchMock()).toHaveBeenCalledTimes(1);
    });

    // Manual v20.4 p. 622, "Possibili valori del campo stato": only a clear refusal is `failed`
    it.each(['Negato', 'Annullato', 'Non Creato', 'NEGATO'])(
      'an existing refused chargeRef (%s) is a verified failure and not charged again',
      async (stato) => {
        fetchMock().mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [{ ...PAID_ENTRY, stato }] }));
        const result = await provider.chargeMandate(mandate(), charge);
        expect(result.status).toBe('failed');
        expect(result.verified).toBe(true);
        expect(result.error).toBe(`A transaction with this chargeRef already exists: ${stato}`);
        expect(fetchMock()).toHaveBeenCalledTimes(1);
      },
    );

    it('a chargeRef still in progress at Nexi (In Corso) is unknown and not charged again', async () => {
      fetchMock().mockResolvedValueOnce(
        jsonResponse({
          ...OK_RESP,
          report: [{ codiceTransazione: 'SUB-0001-2026-12', stato: 'In Corso', importo: 1990, divisa: '978' }],
        }),
      );
      const result = await provider.chargeMandate(mandate(), charge);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.error).toBe('A transaction with this chargeRef is not final at Nexi: In Corso');
      expect(fetchMock()).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['an unrecognised stato', { ...PAID_ENTRY, stato: 'Sospeso' }, 'Sospeso'],
      ['a missing stato', { codiceTransazione: CHARGE_REF, importo: 1990, divisa: 'EUR' }, 'unknown'],
      ['a non-string stato', { ...PAID_ENTRY, stato: 7 }, 'unknown'],
    ])('%s is unknown, never failed, and not charged again', async (_label, entry, shown) => {
      fetchMock().mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [entry] }));
      const result = await provider.chargeMandate(mandate(), charge);
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.error).toBe(`A transaction with this chargeRef is not final at Nexi: ${shown}`);
      expect(fetchMock()).toHaveBeenCalledTimes(1);
    });

    it.each(['Rimborsato', 'Rimborsato Parz.', 'Contabilizzato Parz.'])(
      'a chargeRef already charged then refunded or partly captured (%s) is succeeded, with the stato in raw',
      async (stato) => {
        fetchMock().mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [{ ...PAID_ENTRY, stato }] }));
        const result = await provider.chargeMandate(mandate(), charge);
        expect(result.status).toBe('succeeded');
        expect(result.verified).toBe(true);
        expect(result.providerPaymentId).toBe('SUB-0001-2026-12');
        expect(result.raw).toEqual({ stato });
        // 2.2.0 (#42): the structured state, next to the unchanged raw.stato
        const expected: Record<string, [string, string]> = {
          Rimborsato: ['refunded', 'Rimborsato'],
          'Rimborsato Parz.': ['partially_refunded', 'Rimborsato Parz.'],
          'Contabilizzato Parz.': ['partially_captured', 'Contabilizzato Parz.'],
        };
        expect(result.providerState).toBe(expected[stato][0]);
        expect(result.providerStatus).toBe(expected[stato][1]);
        expect(fetchMock()).toHaveBeenCalledTimes(1);
      },
    );

    it('several entries: in progress beats a refusal, paid beats in progress, all refused is failed', async () => {
      const entry = (stato: string) => ({ ...PAID_ENTRY, stato });

      fetchMock().mockResolvedValueOnce(
        jsonResponse({ ...OK_RESP, report: [entry('Negato'), entry('In Corso')] }),
      );
      const pending = await provider.chargeMandate(mandate(), charge);
      expect(pending.status).toBe('unknown');
      expect(pending.error).toBe('A transaction with this chargeRef is not final at Nexi: In Corso');

      fetchMock().mockReset();
      fetchMock().mockResolvedValueOnce(
        jsonResponse({ ...OK_RESP, report: [entry('In Corso'), entry('Autorizzato')] }),
      );
      expect((await provider.chargeMandate(mandate(), charge)).status).toBe('succeeded');

      fetchMock().mockReset();
      fetchMock().mockResolvedValueOnce(
        jsonResponse({ ...OK_RESP, report: [entry('Negato'), entry('Negato')] }),
      );
      const refused = await provider.chargeMandate(mandate(), charge);
      expect(refused.status).toBe('failed');
      expect(refused.verified).toBe(true);
      expect(fetchMock()).toHaveBeenCalledTimes(1);
    });

    it('KO 9 re-read: a refunded entry is succeeded, an in-progress one unknown', async () => {
      fetchMock()
        .mockResolvedValueOnce(emptyLookup())
        .mockResolvedValueOnce(ko(9))
        .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [{ ...PAID_ENTRY, stato: 'Rimborsato' }] }));
      expect((await provider.chargeMandate(mandate(), charge)).status).toBe('succeeded');

      fetchMock().mockReset();
      fetchMock()
        .mockResolvedValueOnce(emptyLookup())
        .mockResolvedValueOnce(ko(9))
        .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [{ ...PAID_ENTRY, stato: 'In Corso' }] }));
      expect((await provider.chargeMandate(mandate(), charge)).status).toBe('unknown');
    });

    it('through the configurator, a paid replay for another amount becomes unknown', async () => {
      const checkout = new CheckoutConfigurator({ emitEvents: false }).registerProvider(provider);
      fetchMock().mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [PAID_ENTRY] }));
      const result = await checkout.chargeMandate('nexi', mandate(), { ...charge, amount: 29.9 });
      expect(result.status).toBe('unknown');
      expect(result.error).toBe('Charged amount does not match the request');
    });

    it('(h) a signed KO 13 from situazioneOrdine counts as absent and the charge proceeds', async () => {
      fetchMock()
        .mockResolvedValueOnce(jsonResponse(signedKo(13)))
        .mockResolvedValueOnce(jsonResponse({ ...OK_RESP }));
      const result = await provider.chargeMandate(mandate(), charge);
      expect(fetchMock()).toHaveBeenCalledTimes(2);
      expect(callUrl(1)).toBe('https://int-ecommerce.nexi.it/ecomm/api/recurring/pagamentoRicorrente');
      expect(result.status).toBe('succeeded');
    });

    it('(i) a KO 100 or a missing report from situazioneOrdine is unknown and nothing is charged', async () => {
      for (const body of [{ esito: 'KO', errore: { codice: 100 } }, signedKo(100)]) {
        fetchMock().mockReset();
        fetchMock().mockResolvedValueOnce(jsonResponse(body));
        expect((await provider.chargeMandate(mandate(), charge)).status).toBe('unknown');
        expect(fetchMock()).toHaveBeenCalledTimes(1);
      }

      fetchMock().mockReset();
      fetchMock().mockResolvedValueOnce(jsonResponse({ ...OK_RESP }));
      expect((await provider.chargeMandate(mandate(), charge)).status).toBe('unknown');
      expect(fetchMock()).toHaveBeenCalledTimes(1);
    });

    it('a situazioneOrdine OK without MAC, or with a wrong one, is unknown and nothing is charged', async () => {
      const { mac, ...unsigned } = OK_RESP;
      fetchMock().mockResolvedValueOnce(jsonResponse({ ...unsigned, report: [] }));
      expect((await provider.chargeMandate(mandate(), charge)).status).toBe('unknown');
      fetchMock().mockReset();
      fetchMock().mockResolvedValueOnce(jsonResponse({ ...OK_RESP, mac: MAC_CANCEL, report: [] }));
      expect((await provider.chargeMandate(mandate(), charge)).status).toBe('unknown');
      expect(fetchMock()).toHaveBeenCalledTimes(1);
    });

    it('(j) a non-EUR currency or a chargeRef with "_" fails without calling fetch', async () => {
      const usd = await provider.chargeMandate(mandate(), { ...charge, currency: 'USD' });
      expect(usd.status).toBe('failed');
      expect(usd.verified).toBe(false);
      expect(usd.error).toBe('Nexi mandates support EUR only');

      const underscore = await provider.chargeMandate(mandate(), { ...charge, chargeRef: 'SUB_0001' });
      expect(underscore.status).toBe('failed');
      expect(underscore.verified).toBe(false);
      expect(underscore.error).toBe('Nexi codiceTransazione cannot contain "_"');

      expect(fetchMock()).not.toHaveBeenCalled();
    });

    it('an amount over 8 digits of cents fails without calling fetch; 8 digits are sent', async () => {
      const tooLarge = await provider.chargeMandate(mandate(), { ...charge, amount: 1000000 });
      expect(tooLarge.status).toBe('failed');
      expect(tooLarge.verified).toBe(false);
      expect(tooLarge.error).toBe('Amount exceeds the Nexi recurring limit (8 digits of cents)');
      expect(fetchMock()).not.toHaveBeenCalled();

      fetchMock().mockResolvedValueOnce(emptyLookup()).mockResolvedValueOnce(jsonResponse({ ...OK_RESP }));
      const max = await provider.chargeMandate(mandate(), { ...charge, amount: 999999.99 });
      expect(callBody(1).importo).toBe('99999999');
      expect(max.status).toBe('succeeded');
    });
  });

  // ---------------------------------------------------------------------------
  // 2.2.0 (#42) — structured replay state: providerState / providerStatus
  // ---------------------------------------------------------------------------
  describe('chargeMandate, structured replay state (#42)', () => {
    const charge = { chargeRef: CHARGE_REF, amount: 19.9, currency: 'EUR' };
    const emptyLookup = () => jsonResponse({ ...OK_RESP, report: [] });
    const ko = (codice: number, messaggio = 'error') => jsonResponse({ esito: 'KO', errore: { codice, messaggio } });

    it("stato ' rimborsato parz. ' is trimmed in providerStatus, and raw.stato stays verbatim", async () => {
      fetchMock().mockResolvedValueOnce(
        jsonResponse({ ...OK_RESP, report: [{ ...PAID_ENTRY, stato: ' rimborsato parz. ' }] }),
      );
      const result = await provider.chargeMandate(mandate(), charge);
      expect(result.status).toBe('succeeded');
      expect(result.providerState).toBe('partially_refunded');
      expect(result.providerStatus).toBe('rimborsato parz.');
      expect(result.raw).toEqual({ stato: ' rimborsato parz. ' });
    });

    it("a replay of Autorizzato has providerStatus 'Autorizzato' and no providerState", async () => {
      fetchMock().mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [PAID_ENTRY] }));
      const result = await provider.chargeMandate(mandate(), charge);
      expect(result.status).toBe('succeeded');
      expect(result.providerStatus).toBe('Autorizzato');
      expect('providerState' in result).toBe(false);
      expect(result.raw).toEqual({ stato: 'Autorizzato' });
    });

    it('a direct pagamentoRicorrente OK sets neither field', async () => {
      fetchMock()
        .mockResolvedValueOnce(emptyLookup())
        .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, codiceAutorizzazione: 'X1' }));
      const result = await provider.chargeMandate(mandate(), charge);
      expect(result.status).toBe('succeeded');
      expect('providerState' in result).toBe(false);
      expect('providerStatus' in result).toBe(false);
    });

    it("KO 9 re-read: an empty first lookup, KO 9, then a re-read 'Rimborsato' is succeeded and refunded", async () => {
      fetchMock()
        .mockResolvedValueOnce(emptyLookup())
        .mockResolvedValueOnce(ko(9))
        .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [{ ...PAID_ENTRY, stato: 'Rimborsato' }] }));
      const result = await provider.chargeMandate(mandate(), charge);
      expect(fetchMock()).toHaveBeenCalledTimes(3);
      expect(result.status).toBe('succeeded');
      expect(result.verified).toBe(true);
      expect(result.providerState).toBe('refunded');
      expect(result.providerStatus).toBe('Rimborsato');
      expect(result.raw).toEqual({ stato: 'Rimborsato' });
    });

    it('refused and in-progress replays set neither field', async () => {
      for (const stato of ['Negato', 'In Corso']) {
        fetchMock().mockReset();
        fetchMock().mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [{ ...PAID_ENTRY, stato }] }));
        const result = await provider.chargeMandate(mandate(), charge);
        expect(result.status).not.toBe('succeeded');
        expect('providerState' in result).toBe(false);
        expect('providerStatus' in result).toBe(false);
      }
    });

    // Several money-taking entries: amount, currency, raw.stato and providerStatus are the first paid entry's, as in
    // 2.1.0; providerState flags any paid entry that is refunded or partly captured, so the two can come from
    // different entries
    it('[Autorizzato, Rimborsato] keeps the 2.1.0 replay (raw.stato Autorizzato) and adds providerState refunded', async () => {
      fetchMock().mockResolvedValueOnce(
        jsonResponse({ ...OK_RESP, report: [PAID_ENTRY, { ...PAID_ENTRY, stato: 'Rimborsato' }] }),
      );
      const result = await provider.chargeMandate(mandate(), charge);
      expect(result).toEqual({
        status: 'succeeded',
        verified: true,
        chargeRef: CHARGE_REF,
        providerPaymentId: CHARGE_REF,
        amount: 19.9,
        currency: 'EUR',
        providerStatus: 'Autorizzato',
        providerState: 'refunded',
        raw: { stato: 'Autorizzato' },
      });
      expect(fetchMock()).toHaveBeenCalledTimes(1);
    });

    it('[Autorizzato 19.90, Contabilizzato Parz. 10.00] keeps the first paid amount and flags partially_captured', async () => {
      fetchMock().mockResolvedValueOnce(
        jsonResponse({
          ...OK_RESP,
          report: [PAID_ENTRY, { ...PAID_ENTRY, stato: 'Contabilizzato Parz.', importo: 1000 }],
        }),
      );
      const result = await provider.chargeMandate(mandate(), charge);
      expect(result.status).toBe('succeeded');
      expect(result.amount).toBe(19.9);
      expect(result.raw).toEqual({ stato: 'Autorizzato' });
      expect(result.providerStatus).toBe('Autorizzato');
      expect(result.providerState).toBe('partially_captured');
    });

    it('[Rimborsato, Autorizzato] reports the first paid entry, Rimborsato, as in 2.1.0', async () => {
      fetchMock().mockResolvedValueOnce(
        jsonResponse({ ...OK_RESP, report: [{ ...PAID_ENTRY, stato: 'Rimborsato' }, PAID_ENTRY] }),
      );
      const result = await provider.chargeMandate(mandate(), charge);
      expect(result.raw).toEqual({ stato: 'Rimborsato' });
      expect(result.providerStatus).toBe('Rimborsato');
      expect(result.providerState).toBe('refunded');
    });

    it('the KO 9 re-read selects the same way: [Autorizzato, Rimborsato] keeps raw.stato Autorizzato', async () => {
      fetchMock()
        .mockResolvedValueOnce(emptyLookup())
        .mockResolvedValueOnce(ko(9))
        .mockResolvedValueOnce(
          jsonResponse({ ...OK_RESP, report: [PAID_ENTRY, { ...PAID_ENTRY, stato: 'Rimborsato' }] }),
        );
      const result = await provider.chargeMandate(mandate(), charge);
      expect(fetchMock()).toHaveBeenCalledTimes(3);
      expect(result.status).toBe('succeeded');
      expect(result.raw).toEqual({ stato: 'Autorizzato' });
      expect(result.providerStatus).toBe('Autorizzato');
      expect(result.providerState).toBe('refunded');
    });
  });

  // ---------------------------------------------------------------------------
  // AC 6 — revokeMandate
  // ---------------------------------------------------------------------------
  describe('revokeMandate (AC 6)', () => {
    it('posts cancellaContratto with the cancel MAC', async () => {
      fetchMock().mockResolvedValueOnce(jsonResponse(OK_RESP));
      const result = await provider.revokeMandate(mandate());
      expect(callUrl(0)).toBe('https://int-ecommerce.nexi.it/ecomm/api/contratti/cancellaContratto');
      expect(callBody(0)).toEqual({
        apiKey: 'ALIAS_TEST_01',
        numeroContratto: 'MNDT0000000001',
        timeStamp: '1767225600000',
        mac: 'ef8699b39d42f5e2cacd6b5b13b0f319b281f330',
      });
      expect(result.revokedAtProvider).toBe(true);
    });

    it('KO 8 (contract already gone) is revoked; KO 3 is not', async () => {
      fetchMock().mockResolvedValueOnce(jsonResponse({ esito: 'KO', errore: { codice: 8, messaggio: 'x' } }));
      expect((await provider.revokeMandate(mandate())).revokedAtProvider).toBe(true);

      fetchMock().mockResolvedValueOnce(jsonResponse({ esito: 'KO', errore: { codice: 3, messaggio: 'x' } }));
      const refused = await provider.revokeMandate(mandate());
      expect(refused.revokedAtProvider).toBe(false);
      expect(refused.error).toBeTruthy();
    });

    it('an OK with a wrong MAC or an HTTP error is not revoked', async () => {
      fetchMock().mockResolvedValueOnce(jsonResponse({ ...OK_RESP, mac: MAC_CANCEL }));
      expect((await provider.revokeMandate(mandate())).revokedAtProvider).toBe(false);
      fetchMock().mockResolvedValueOnce(jsonResponse({}, 500));
      expect((await provider.revokeMandate(mandate())).revokedAtProvider).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // AC 7 — getMandate
  // ---------------------------------------------------------------------------
  describe('getMandate (AC 7)', () => {
    it('posts dettagliContratto with the details MAC and the three empty optional fields', async () => {
      fetchMock().mockResolvedValueOnce(
        jsonResponse({ ...OK_RESP, contratti: [{ numeroContratto: 'MNDT0000000001', statoPrimoPag: 'OK' }] }),
      );
      const result = await provider.getMandate(mandate());
      expect(callUrl(0)).toBe('https://int-ecommerce.nexi.it/ecomm/api/contratti/dettagliContratto');
      expect(callBody(0)).toEqual({
        apiKey: 'ALIAS_TEST_01',
        numeroContratto: 'MNDT0000000001',
        codiceFiscale: '',
        dataRegistrazioneDa: '',
        dataRegistrazioneA: '',
        timeStamp: '1767225600000',
        mac: '69237bb9072ccbae03137a7b7e5ef5def8a00055',
      });
      expect(callBody(0).mac).toBe(MAC_DETAILS);
      expect(result.status).toBe('active');
      expect(result.verified).toBe(true);
    });

    it("statoPrimoPag 'KO' is revoked", async () => {
      fetchMock().mockResolvedValueOnce(
        jsonResponse({ ...OK_RESP, contratti: [{ numeroContratto: 'MNDT0000000001', statoPrimoPag: 'KO' }] }),
      );
      expect(await provider.getMandate(mandate())).toMatchObject({ status: 'revoked', verified: true });
    });

    it("statoPrimoPag is compared case-insensitively ('ko' is revoked)", async () => {
      fetchMock().mockResolvedValueOnce(
        jsonResponse({ ...OK_RESP, contratti: [{ numeroContratto: 'MNDT0000000001', statoPrimoPag: 'ko' }] }),
      );
      expect(await provider.getMandate(mandate())).toMatchObject({ status: 'revoked', verified: true });
    });

    it('KO 2 (not found) is revoked', async () => {
      fetchMock().mockResolvedValueOnce(jsonResponse({ esito: 'KO', errore: { codice: 2, messaggio: 'x' } }));
      expect(await provider.getMandate(mandate())).toMatchObject({ status: 'revoked', verified: true });
    });

    it('HTTP 500, a wrong MAC or a missing contract is unknown and unverified', async () => {
      fetchMock().mockResolvedValueOnce(jsonResponse({}, 500));
      expect(await provider.getMandate(mandate())).toMatchObject({ status: 'unknown', verified: false });

      fetchMock().mockResolvedValueOnce(
        jsonResponse({ ...OK_RESP, mac: MAC_CANCEL, contratti: [{ numeroContratto: 'MNDT0000000001' }] }),
      );
      expect(await provider.getMandate(mandate())).toMatchObject({ status: 'unknown', verified: false });

      fetchMock().mockResolvedValueOnce(jsonResponse({ ...OK_RESP, contratti: [] }));
      expect(await provider.getMandate(mandate())).toMatchObject({ status: 'unknown', verified: false });
    });
  });

  // ---------------------------------------------------------------------------
  // #46 — unsigned payment-method hints out of the persisted Mandate
  // ---------------------------------------------------------------------------
  describe('payment-method hints through the configurator (#46)', () => {
    // `pan` and `scadenza_pan` are not covered by the outcome MAC
    const callback = () => ({ query: { ...okOutcome(), pan: '453997******0006' } });

    async function confirmThrough(config?: CheckoutConfig) {
      const checkout = new CheckoutConfigurator(config).registerProvider(new NexiProvider(baseConfig));
      return checkout.confirmMandate('nexi', pendingState(), callback());
    }

    it('default config: outcome.hints, and outcome.mandate.unverified deep-equal to it (the 2.1 placement)', async () => {
      const outcome = await confirmThrough();
      expect(outcome).toMatchObject({ success: true, verified: true, terminal: true });
      expect(outcome.hints).toStrictEqual({ cardExpiry: '203012', maskedPan: '453997******0006' });
      expect(outcome.mandate!.unverified).toStrictEqual({ cardExpiry: '203012', maskedPan: '453997******0006' });
    });

    it("{ mandateHints: 'separate' }: the same outcome.hints, and a mandate without card data", async () => {
      const outcome = await confirmThrough({ mandateHints: 'separate' });
      expect(outcome).toMatchObject({ success: true, verified: true, terminal: true });
      expect(outcome.hints).toStrictEqual({ cardExpiry: '203012', maskedPan: '453997******0006' });
      expect('unverified' in outcome.mandate!).toBe(false);
      expect(JSON.stringify(outcome.mandate)).not.toContain('453997');
      expect(JSON.stringify(outcome.mandate)).not.toContain('203012');
      expect(outcome.mandate).toStrictEqual({
        provider: 'nexi',
        mandateRef: 'MNDT0000000001',
        providerMandateId: 'MNDT0000000001',
        status: 'active',
        createdAt: new Date(NOW).toISOString(),
      });
      // Out of scope: `raw` still holds the unfiltered callback fields (never persist or log it)
      expect((outcome.raw as Record<string, string>).pan).toBe('453997******0006');
      expect((outcome.raw as Record<string, string>).scadenza_pan).toBe('203012');
    });

    it('malformed pan and scadenza_pan give no hints and no unverified, in either mode', async () => {
      for (const config of [{}, { mandateHints: 'separate' }] as CheckoutConfig[]) {
        const checkout = new CheckoutConfigurator(config).registerProvider(new NexiProvider(baseConfig));
        const outcome = await checkout.confirmMandate('nexi', pendingState(), {
          query: { ...okOutcome(), pan: '<script>', scadenza_pan: '2030-12' },
        });
        expect(outcome.success).toBe(true);
        expect(outcome.hints).toBeUndefined();
        expect('unverified' in outcome.mandate!).toBe(false);
      }
    });

    it('a separate-mode mandate, JSON round-tripped, charges, reads and revokes with the requests of the 2.1-shaped one', async () => {
      const persisted = async (config: CheckoutConfig) =>
        JSON.parse(JSON.stringify((await confirmThrough(config)).mandate)) as Mandate;
      const separate = await persisted({ mandateHints: 'separate' });
      const legacy = await persisted({}); // what 2.1 returned and apps persisted: it still has unverified
      expect('unverified' in separate).toBe(false);
      expect(legacy.unverified).toStrictEqual({ cardExpiry: '203012', maskedPan: '453997******0006' });

      /** The provider requests of chargeMandate, getMandate and revokeMandate on a fresh configurator. */
      const requests = async (persistedMandate: Mandate) => {
        fetchMock().mockReset();
        fetchMock()
          .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [] }))
          .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, codiceAutorizzazione: 'X1' }))
          .mockResolvedValueOnce(
            jsonResponse({ ...OK_RESP, contratti: [{ numeroContratto: 'MNDT0000000001', statoPrimoPag: 'OK' }] }),
          )
          .mockResolvedValueOnce(jsonResponse(OK_RESP));
        const checkout = new CheckoutConfigurator().registerProvider(new NexiProvider(baseConfig));
        const charged = await checkout.chargeMandate('nexi', persistedMandate, {
          chargeRef: CHARGE_REF,
          amount: 19.9,
          currency: 'EUR',
        });
        expect(charged).toMatchObject({ status: 'succeeded', verified: true, chargeRef: 'SUB-0001-2026-12' });
        expect(await checkout.getMandate('nexi', persistedMandate)).toMatchObject({ status: 'active', verified: true });
        expect((await checkout.revokeMandate('nexi', persistedMandate)).revokedAtProvider).toBe(true);
        return fetchMock().mock.calls.map(([url, init]) => ({
          url: String(url),
          body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
        }));
      };

      const sent = await requests(separate);
      expect(sent.map((r) => r.url)).toEqual([
        'https://int-ecommerce.nexi.it/ecomm/api/bo/situazioneOrdine',
        'https://int-ecommerce.nexi.it/ecomm/api/recurring/pagamentoRicorrente',
        'https://int-ecommerce.nexi.it/ecomm/api/contratti/dettagliContratto',
        'https://int-ecommerce.nexi.it/ecomm/api/contratti/cancellaContratto',
      ]);
      expect(sent[1].body).toStrictEqual({
        apiKey: 'ALIAS_TEST_01',
        numeroContratto: 'MNDT0000000001',
        codiceTransazione: 'SUB-0001-2026-12',
        importo: '1990',
        divisa: '978',
        timeStamp: '1767225600000',
        mac: 'c7f22774f25738eb5283df704e658ba98ba0a9e5',
      });
      expect(sent[2].body.mac).toBe('69237bb9072ccbae03137a7b7e5ef5def8a00055');
      expect(sent[3].body.mac).toBe('ef8699b39d42f5e2cacd6b5b13b0f319b281f330');
      expect(await requests(legacy)).toStrictEqual(sent);
    });
  });

  // ---------------------------------------------------------------------------
  // AC 8 — refund of a mandate charge. Since 2.3.0 (#51) the default refund API is bo/storna (nexi.refund.spec.ts):
  // the 2.2.0 endpoint tests run with refundApi: 'legacy'
  // ---------------------------------------------------------------------------
  it("refundPayment(chargeRef, amount) refunds a mandate charge through the 2.2.0 endpoint with refundApi: 'legacy' (AC 8)", async () => {
    provider = new NexiProvider({ ...baseConfig, refundApi: 'legacy' });
    fetchMock().mockResolvedValueOnce(jsonResponse({ esito: 'OK' }));
    const result = await provider.refundPayment('SUB-0001-2026-12', 19.9);
    expect(callUrl(0)).toBe('https://int-ecommerce.nexi.it/ecomm/api/vas/igfs/storno/plain');
    const body = (fetchMock().mock.calls[0][1] as RequestInit).body as URLSearchParams;
    expect(body.get('codTrans')).toBe('SUB-0001-2026-12');
    expect(body.get('importo')).toBe('1990');
    expect(result.success).toBe(true);
  });

  it('refundPayment with an idempotency key, called directly, refuses without any request (#44)', async () => {
    expect(provider.supportsRefundIdempotency).not.toBe(true);
    const result = await provider.refundPayment('SUB-0001-2026-12', 19.9, { idempotencyKey: 'refund-SUB-0001-R1' });
    expect(result).toEqual({
      success: false,
      status: 'REFUND_FAILED',
      error: 'Nexi refunds do not support an idempotency key',
    });
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('refundPayment called directly with any key, or with options of another shape, refuses without any request (#44)', async () => {
    for (const idempotencyKey of ['short', 123 as unknown as string]) {
      expect(await provider.refundPayment('SUB-0001-2026-12', 19.9, { idempotencyKey })).toEqual({
        success: false,
        status: 'REFUND_FAILED',
        error: 'Nexi refunds do not support an idempotency key',
      });
    }
    // options is typed unknown (for 2.1 subclasses with a third parameter of their own): other shapes are refused
    for (const options of ['duplicate', 42, [], { idempotencyKy: 'refund-SUB-0001-R1' }, { reason: 'duplicate' }]) {
      expect(await provider.refundPayment('SUB-0001-2026-12', 19.9, options)).toEqual({
        success: false,
        status: 'REFUND_FAILED',
        error: 'Invalid refund options',
      });
    }
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("refundPayment with options but no key sends the storno as before, with refundApi: 'legacy' (#44)", async () => {
    provider = new NexiProvider({ ...baseConfig, refundApi: 'legacy' });
    fetchMock().mockResolvedValueOnce(jsonResponse({ esito: 'OK' }));
    const result = await provider.refundPayment('SUB-0001-2026-12', 19.9, {});
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(callUrl(0)).toBe('https://int-ecommerce.nexi.it/ecomm/api/vas/igfs/storno/plain');
    expect(result.success).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // AC 9 — end to end through CheckoutConfigurator and the Express callback route
  // ---------------------------------------------------------------------------
  it('setup → callback → chargeMandate emits mandate.created, charge.succeeded, charge.succeeded (AC 9)', async () => {
    const checkout = new CheckoutConfigurator().registerProvider(provider);
    const events: { name: CheckoutEventName; payload: CheckoutEventPayload }[] = [];
    for (const name of ['mandate.created', 'mandate.setup_failed', 'charge.succeeded', 'charge.failed', 'charge.unknown'] as const) {
      checkout.events.on(name, (payload) => {
        events.push({ name, payload });
      });
    }

    const pendings = new Map<string, { pending: MandatePendingState; consumed: boolean }>();
    const mandates = new Map<string, Mandate>();
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(
      '/checkout',
      createCheckoutRouter(checkout, {
        buildPaymentRequest: () => null,
        mandates: {
          buildMandateRequest: () => setupRequest({ notifyUrl: CALLBACK }),
          onStarted: (start) => {
            if (start.success && start.pending) {
              pendings.set(start.pending.mandateRef, { pending: start.pending, consumed: false });
            }
          },
          loadPending: (_req, { mandateRef }) => {
            const row = pendings.get(mandateRef);
            return row && !row.consumed ? row.pending : null;
          },
          onOutcome: (outcome, req, res) => {
            const row = pendings.get(String(req.query.mandate_ref));
            if (outcome.terminal && row && !row.consumed) {
              row.consumed = true;
              if (outcome.mandate) mandates.set(outcome.mandate.mandateRef, outcome.mandate);
            }
            if (req.method === 'GET') res.redirect(302, outcome.success ? '/app/subscribed' : '/app/failed');
          },
        },
      }),
    );

    // 1. Setup
    const started = await request(app).post('/checkout/nexi/mandate').send({});
    expect(started.status).toBe(201);
    expect(started.body.pending).toBeUndefined();
    const approval = new URL(started.body.approvalUrl);
    expect(approval.searchParams.get('mac')).toBe(MAC_SETUP);

    // 2. Nexi redirects the customer to `url`, appending the outcome
    const back = new URL(approval.searchParams.get('url')!);
    const { mandate_ref, ...outcome } = okOutcome();
    for (const [k, v] of Object.entries(outcome)) back.searchParams.set(k, v);
    const callback = await request(app).get(`${back.pathname}${back.search}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('/app/subscribed');

    // The urlpost notification for the same setup now finds no pending state
    const urlpost = new URL(approval.searchParams.get('urlpost')!);
    const replay = await request(app).post(`${urlpost.pathname}${urlpost.search}`).type('form').send(outcome);
    expect(replay.status).toBe(404);

    const saved = mandates.get(MANDATE_REF)!;
    expect(saved.providerMandateId).toBe('MNDT0000000001');

    // 3. Renewal, from a server job (JSON round trip of the persisted mandate)
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [] }))
      .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, codiceAutorizzazione: 'X1' }));
    const renewal = await checkout.chargeMandate('nexi', JSON.parse(JSON.stringify(saved)), {
      chargeRef: CHARGE_REF,
      amount: 19.9,
      currency: 'EUR',
    });
    expect(renewal.status).toBe('succeeded');
    expect(callBody(1).mac).toBe(MAC_CHARGE);

    expect(events.map((e) => e.name)).toEqual(['mandate.created', 'charge.succeeded', 'charge.succeeded']);
    expect(events[1].payload.orderId).toBe('SUB-0001-INIT');
    expect(events[2].payload.orderId).toBe('SUB-0001-2026-12');
    expect(events.every((e) => e.payload.data?.mandateRef === MANDATE_REF)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // urlpost must get HTTP 200 (manual pp. 22, 33) — the README onOutcome pattern
  // ---------------------------------------------------------------------------
  describe('callback route with the README onOutcome (redirect only GET)', () => {
    function readmeApp() {
      const checkout = new CheckoutConfigurator().registerProvider(provider);
      const events: CheckoutEventName[] = [];
      for (const name of ['mandate.created', 'mandate.setup_failed', 'charge.succeeded', 'charge.failed'] as const) {
        checkout.events.on(name, () => {
          events.push(name);
        });
      }
      const row = { pending: pendingState(), consumed: false };
      const mandates = new Map<string, Mandate>();
      const app = express();
      app.use(express.json());
      app.use(express.urlencoded({ extended: false }));
      app.use(
        '/checkout',
        createCheckoutRouter(checkout, {
          buildPaymentRequest: () => null,
          mandates: {
            buildMandateRequest: () => setupRequest({ notifyUrl: CALLBACK }),
            onStarted: () => undefined,
            loadPending: (_req, { mandateRef }) =>
              mandateRef === row.pending.mandateRef && !row.consumed ? row.pending : null,
            onOutcome: (outcome, req, res) => {
              if (outcome.terminal && !row.consumed) {
                row.consumed = true;
                if (outcome.mandate) mandates.set(outcome.mandate.mandateRef, outcome.mandate);
              }
              if (req.method === 'GET') {
                res.redirect(302, outcome.success ? '/app/subscribed' : '/app/failed');
              }
            },
          },
        }),
      );
      return { app, events, mandates };
    }
    const path = '/checkout/nexi/mandate/callback?mandate_ref=MNDT0000000001';

    it('answers the urlpost form POST of the OK outcome with HTTP 200, then the browser GET with 404', async () => {
      const { app, events, mandates } = readmeApp();
      const { mandate_ref, ...outcome } = okOutcome();
      expect(outcome.mac).toBe('b30009179e6be7f2af68aebff7182845e2acf905');

      const urlpost = await request(app).post(path).type('form').send(outcome);
      expect(urlpost.status).toBe(200);
      expect(urlpost.body).toEqual({ success: true });
      expect(mandates.get('MNDT0000000001')?.status).toBe('active');
      expect(events).toEqual(['mandate.created', 'charge.succeeded']);

      // On a terminal that voids on notification failure, the redirect follows the urlpost answer
      const browser = await request(app).get(`${path}&${new URLSearchParams(outcome)}`);
      expect(browser.status).toBe(404);
    });

    it('a KO consumes the setup, so an OK for the same codTrans (multi-attempt terminal) answers 404', async () => {
      const { app, events, mandates } = readmeApp();
      const { mandate_ref, ...ok } = okOutcome();
      const ko = { ...ok, esito: 'KO', codAut: '', mac: 'f7eeec5816848954885a5843445723677977db96' };

      const first = await request(app).post(path).type('form').send(ko);
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ success: false });

      const second = await request(app).post(path).type('form').send(ok);
      expect(second.status).toBe(404);
      expect(mandates.size).toBe(0);
      expect(events).toEqual(['mandate.setup_failed', 'charge.failed']);
    });
  });
});
