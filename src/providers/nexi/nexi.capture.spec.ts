import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import { NexiProvider, NexiProviderConfig } from './nexi.provider';
import { PaymentRequest } from '../../models/payment-request.model';
import { ChargeRequest, Mandate, MandatePendingState, MandateSetupRequest } from '../../models/mandate.model';

// Opt-in immediate capture on Nexi XPay (#52): `captureMode: 'immediate'` sends `TCONTAB=C` on the hosted payment
// (`createPayment`), the mandate setup (`createMandate`) and every `pagamentoRicorrente` (`chargeMandate`, in the
// `parametriAggiuntivi` object). TCONTAB is in none of the MACs (manual v20.4 pp. 24-27, 60-61, 189-191; fragments 3,
// 426, 427), so every MAC below is a literal from issue #52, "Acceptance criteria": the value without the option,
// computed independently of the implementation.

function fetchMock() {
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function callBody(i: number): Record<string, unknown> {
  return JSON.parse(String((fetchMock().mock.calls[i][1] as RequestInit).body));
}

/** The query parameters of an approval URL, in order. */
function params(approvalUrl: string | undefined): [string, string][] {
  return [...new URL(approvalUrl!).searchParams.entries()];
}

const INVALID_CAPTURE_MODES: unknown[] = ['C', 'D', 'deferred', 'IMMEDIATE', true, '', null, 'Profile', 0];

describe('NexiProvider captureMode (#52)', () => {
  // ---------------------------------------------------------------------------
  // createPayment: config and request of nexi.provider.spec.ts:13-54
  // ---------------------------------------------------------------------------
  describe('createPayment (hosted payment start)', () => {
    const config = {
      merchantId: 'TEST_MERCHANT',
      macKey: 'super-secret-mac-key',
      environment: 'sandbox' as const,
    };
    /** sha1('codTrans=ORD-001divisa=EURimporto=1999super-secret-mac-key'): the MAC without the option. */
    const MAC_ORD_001 = '34c709ffc58844212c2306c7c2f6c3a80dcb3b54';
    const req: PaymentRequest = {
      amount: 19.99,
      currency: 'EUR',
      returnUrl: 'https://myapp.com/success',
      cancelUrl: 'https://myapp.com/cancel',
      orderId: 'ORD-001',
    };

    beforeEach(() => {
      global.fetch = vi.fn();
    });

    it("without captureMode, and with 'profile', the approvalUrl has no TCONTAB parameter (2.2.0 request)", async () => {
      const without = await new NexiProvider(config).createPayment(req);
      const profile = await new NexiProvider({ ...config, captureMode: 'profile' }).createPayment(req);
      for (const result of [without, profile]) {
        expect(result.success).toBe(true);
        const q = new URL(result.approvalUrl!).searchParams;
        expect(q.has('TCONTAB')).toBe(false);
        expect(q.get('mac')).toBe('34c709ffc58844212c2306c7c2f6c3a80dcb3b54');
      }
      expect(profile.approvalUrl).toBe(without.approvalUrl);
      expect(params(without.approvalUrl).map(([k]) => k)).toEqual([
        'alias',
        'importo',
        'divisa',
        'codTrans',
        'url',
        'url_back',
        'mac',
      ]);
      expect(fetchMock()).not.toHaveBeenCalled();
    });

    it("with 'immediate', TCONTAB is C and the MAC is the one without the option", async () => {
      const result = await new NexiProvider({ ...config, captureMode: 'immediate' }).createPayment(req);
      expect(result).toMatchObject({ success: true, paymentId: 'ORD-001', status: 'CREATED' });
      const q = new URL(result.approvalUrl!).searchParams;
      expect(q.get('TCONTAB')).toBe('C');
      expect(q.get('mac')).toBe('34c709ffc58844212c2306c7c2f6c3a80dcb3b54');
      expect(q.get('mac')).toBe(MAC_ORD_001);
      expect(q.getAll('TCONTAB')).toEqual(['C']);

      // Every other parameter equals the default's, in the same order; TCONTAB comes last
      const without = await new NexiProvider(config).createPayment(req);
      expect(params(result.approvalUrl).filter(([k]) => k !== 'TCONTAB')).toEqual(params(without.approvalUrl));
      const all = params(result.approvalUrl);
      expect(all[all.length - 1]).toEqual(['TCONTAB', 'C']);
      expect(new URL(result.approvalUrl!).origin + new URL(result.approvalUrl!).pathname).toBe(
        'https://int-ecommerce.nexi.it/ecomm/ecomm/DispatcherServlet',
      );
    });

    it("with 'immediate', a group and a notifyUrl, TCONTAB follows gruppo and the MAC is unchanged", async () => {
      const notify = { ...req, notifyUrl: 'https://myapp.com/checkout/nexi/webhook' };
      const result = await new NexiProvider({ ...config, group: 'TEST_GROUP', captureMode: 'immediate' }).createPayment(notify);
      expect(params(result.approvalUrl).map(([k]) => k)).toEqual([
        'alias',
        'importo',
        'divisa',
        'codTrans',
        'url',
        'url_back',
        'mac',
        'urlpost',
        'gruppo',
        'TCONTAB',
      ]);
      const q = new URL(result.approvalUrl!).searchParams;
      expect(q.get('TCONTAB')).toBe('C');
      expect(q.get('gruppo')).toBe('TEST_GROUP');
      expect(q.get('mac')).toBe(MAC_ORD_001);
    });

    it("an invalid currency or amount still fails before any URL, with 'immediate'", async () => {
      const provider = new NexiProvider({ ...config, captureMode: 'immediate' });
      expect(await provider.createPayment({ ...req, currency: 'JPY' })).toMatchObject({ success: false, status: 'FAILED' });
      expect(await provider.createPayment({ ...req, amount: 19.999 })).toMatchObject({ success: false, status: 'FAILED' });
    });
  });

  // ---------------------------------------------------------------------------
  // Mandates: harness of nexi.mandates.spec.ts
  // ---------------------------------------------------------------------------
  describe('mandates', () => {
    const MERCHANT_ID = 'ALIAS_TEST_01';
    const MAC_KEY = 'TEST_SECRET_KEY_0001';
    const NOW = 1767225600000;
    /** sha1('codTrans=SUB-0001-INITdivisa=EURimporto=1990TEST_SECRET_KEY_0001'). */
    const MAC_SETUP = 'ea1f188b47f63e76234075c60d3185e45f197874';
    /** sha1('codTrans=SUB-0001-INITdivisa=EURimporto=1990tipo_contratto=STEST_SECRET_KEY_0001'). */
    const MAC_SETUP_S = 'b85222313352bd9d618e9828e4beb73e5200ddf8';
    /** The pagamentoRicorrente MAC of SUB-0001-2026-12, 19.90 EUR, at NOW. */
    const MAC_CHARGE = 'c7f22774f25738eb5283df704e658ba98ba0a9e5';
    const MAC_API_RESPONSE_OK = '2a8dbadc3faa3fe66c9f67f9d360da3039ce207a';
    /** The outcome MAC of the setup's OK (nexi.mandates.spec.ts `MAC_OUTCOME_OK`). */
    const MAC_OUTCOME_OK = 'b30009179e6be7f2af68aebff7182845e2acf905';
    const OK_RESP = { esito: 'OK', idOperazione: '123456789', timeStamp: '1767225601000', mac: MAC_API_RESPONSE_OK };
    const MANDATE_REF = 'MNDT0000000001';
    const ORDER_ID = 'SUB-0001-INIT';
    const CHARGE_REF = 'SUB-0001-2026-12';
    const CALLBACK = 'https://app.test/checkout/nexi/mandate/callback';
    const PAID_ENTRY = { codiceTransazione: CHARGE_REF, stato: 'Autorizzato', importo: 1990, divisa: 'EUR' };
    const baseConfig: NexiProviderConfig = { merchantId: MERCHANT_ID, macKey: MAC_KEY, environment: 'sandbox' };
    const charge: ChargeRequest = { chargeRef: CHARGE_REF, amount: 19.9, currency: 'EUR' };

    /** The pagamentoRicorrente body of nexi.mandates.spec.ts:412-420 and :1100-1108, without the option. */
    const CHARGE_BODY = {
      apiKey: 'ALIAS_TEST_01',
      numeroContratto: 'MNDT0000000001',
      codiceTransazione: 'SUB-0001-2026-12',
      importo: '1990',
      divisa: '978',
      timeStamp: '1767225600000',
      mac: 'c7f22774f25738eb5283df704e658ba98ba0a9e5',
    };

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

    function mandate(): Mandate {
      return {
        provider: 'nexi',
        mandateRef: MANDATE_REF,
        providerMandateId: MANDATE_REF,
        status: 'active',
        createdAt: new Date(NOW).toISOString(),
      };
    }

    /** Fixture input only (a KO answer with a valid MAC has no literal vector): never asserted. */
    function signedKo(codice: number): Record<string, unknown> {
      const idOperazione = '123456790';
      const timeStamp = '1767225601000';
      const mac = crypto
        .createHash('sha1')
        .update(`esito=KOidOperazione=${idOperazione}timeStamp=${timeStamp}${MAC_KEY}`)
        .digest('hex');
      return { esito: 'KO', idOperazione, timeStamp, errore: { codice, messaggio: 'refused' }, mac };
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      global.fetch = vi.fn();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    describe('createMandate (setup, paga_multi)', () => {
      it("with 'immediate', TCONTAB is C, the MAC is MAC_SETUP and every other parameter equals the default's", async () => {
        const start = await new NexiProvider({ ...baseConfig, captureMode: 'immediate' }).createMandate(setupRequest());
        expect(start.success).toBe(true);
        const q = new URL(start.approvalUrl!).searchParams;
        expect(q.get('TCONTAB')).toBe('C');
        expect(q.get('mac')).toBe('ea1f188b47f63e76234075c60d3185e45f197874');
        expect(q.get('mac')).toBe(MAC_SETUP);
        expect(q.get('num_contratto')).toBe('MNDT0000000001');
        expect(q.get('tipo_servizio')).toBe('paga_multi');
        expect(q.get('tipo_richiesta')).toBe('PP');

        const without = await new NexiProvider(baseConfig).createMandate(setupRequest());
        expect(params(start.approvalUrl).filter(([k]) => k !== 'TCONTAB')).toEqual(params(without.approvalUrl));
        expect(start.pending).toEqual(without.pending);
      });

      it("with 'immediate' and contractType 'S', the MAC is MAC_SETUP_S, with tipo_contratto=S and TCONTAB=C", async () => {
        const start = await new NexiProvider({ ...baseConfig, contractType: 'S', captureMode: 'immediate' }).createMandate(
          setupRequest(),
        );
        const q = new URL(start.approvalUrl!).searchParams;
        expect(q.get('mac')).toBe('b85222313352bd9d618e9828e4beb73e5200ddf8');
        expect(q.get('mac')).toBe(MAC_SETUP_S);
        expect(q.get('tipo_contratto')).toBe('S');
        expect(q.get('TCONTAB')).toBe('C');
      });

      it("with 'immediate', a notifyUrl and a group, TCONTAB follows gruppo", async () => {
        const start = await new NexiProvider({ ...baseConfig, group: 'GRP01', captureMode: 'immediate' }).createMandate(
          setupRequest({ notifyUrl: `${CALLBACK}?src=urlpost` }),
        );
        expect(params(start.approvalUrl).map(([k]) => k)).toEqual([
          'alias',
          'importo',
          'divisa',
          'codTrans',
          'url',
          'url_back',
          'mac',
          'num_contratto',
          'tipo_servizio',
          'tipo_richiesta',
          'urlpost',
          'gruppo',
          'TCONTAB',
        ]);
        expect(new URL(start.approvalUrl!).searchParams.get('mac')).toBe(MAC_SETUP);
      });

      it("without the option, and with 'profile', q.has('TCONTAB') is false and the URL is the 2.2.0 one", async () => {
        const without = await new NexiProvider(baseConfig).createMandate(setupRequest());
        const profile = await new NexiProvider({ ...baseConfig, captureMode: 'profile' }).createMandate(setupRequest());
        for (const start of [without, profile]) {
          const q = new URL(start.approvalUrl!).searchParams;
          expect(q.has('TCONTAB')).toBe(false);
          expect(q.get('mac')).toBe(MAC_SETUP);
        }
        expect(profile.approvalUrl).toBe(without.approvalUrl);
      });

      it("confirmMandate of the setup's OK outcome is unchanged with 'immediate' (TCONTAB is not in the outcome MAC)", async () => {
        const pending: MandatePendingState = {
          provider: 'nexi',
          mandateRef: MANDATE_REF,
          orderId: ORDER_ID,
          amount: 19.9,
          currency: 'EUR',
          providerRef: ORDER_ID,
          createdAt: new Date(NOW).toISOString(),
        };
        const query = {
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
        };
        const immediate = await new NexiProvider({ ...baseConfig, captureMode: 'immediate' }).confirmMandate(pending, { query });
        const without = await new NexiProvider(baseConfig).confirmMandate(pending, { query });
        expect(immediate).toMatchObject({ success: true, verified: true, terminal: true });
        expect(immediate).toEqual(without);
        expect(fetchMock()).not.toHaveBeenCalled();
      });
    });

    describe('chargeMandate (pagamentoRicorrente)', () => {
      it("with 'immediate', pagamentoRicorrente carries parametriAggiuntivi { TCONTAB: 'C' } and the same MAC", async () => {
        fetchMock()
          .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [] }))
          .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, codiceAutorizzazione: 'X1' }));
        const result = await new NexiProvider({ ...baseConfig, captureMode: 'immediate' }).chargeMandate(mandate(), charge);

        expect(fetchMock()).toHaveBeenCalledTimes(2);
        expect(String(fetchMock().mock.calls[0][0])).toBe('https://int-ecommerce.nexi.it/ecomm/api/bo/situazioneOrdine');
        expect('parametriAggiuntivi' in callBody(0)).toBe(false);
        expect(String(fetchMock().mock.calls[1][0])).toBe(
          'https://int-ecommerce.nexi.it/ecomm/api/recurring/pagamentoRicorrente',
        );
        expect(callBody(1)).toStrictEqual({
          apiKey: 'ALIAS_TEST_01',
          numeroContratto: 'MNDT0000000001',
          codiceTransazione: 'SUB-0001-2026-12',
          importo: '1990',
          divisa: '978',
          timeStamp: '1767225600000',
          mac: 'c7f22774f25738eb5283df704e658ba98ba0a9e5',
          parametriAggiuntivi: { TCONTAB: 'C' },
        });
        expect(callBody(1).mac).toBe(MAC_CHARGE);
        // A JSON object, not a string
        expect(JSON.parse(String((fetchMock().mock.calls[1][1] as RequestInit).body)).parametriAggiuntivi).toEqual({
          TCONTAB: 'C',
        });
        expect(result).toMatchObject({ status: 'succeeded', verified: true, chargeRef: CHARGE_REF });
      });

      it("with 'immediate' and group 'GRP1', the body also has codiceGruppo: 'GRP1'", async () => {
        fetchMock()
          .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [] }))
          .mockResolvedValueOnce(jsonResponse({ ...OK_RESP }));
        await new NexiProvider({ ...baseConfig, group: 'GRP1', captureMode: 'immediate' }).chargeMandate(mandate(), charge);
        expect(callBody(1)).toStrictEqual({
          ...CHARGE_BODY,
          codiceGruppo: 'GRP1',
          parametriAggiuntivi: { TCONTAB: 'C' },
        });
        expect(Object.keys(callBody(1)).slice(-2)).toEqual(['codiceGruppo', 'parametriAggiuntivi']);
        expect('parametriAggiuntivi' in callBody(0)).toBe(false);
      });

      it("without the option, and with 'profile', no body has a parametriAggiuntivi key (2.2.0 requests)", async () => {
        for (const config of [baseConfig, { ...baseConfig, captureMode: 'profile' as const }]) {
          fetchMock().mockReset();
          fetchMock()
            .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [] }))
            .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, codiceAutorizzazione: 'X1' }));
          await new NexiProvider(config).chargeMandate(mandate(), charge);
          expect(fetchMock()).toHaveBeenCalledTimes(2);
          expect(callBody(1)).toStrictEqual(CHARGE_BODY);
          for (const i of [0, 1]) expect('parametriAggiuntivi' in callBody(i)).toBe(false);
        }
      });

      it("with 'immediate', an OK maps to { status: 'succeeded', verified: true } as without the option", async () => {
        const run = async (config: NexiProviderConfig) => {
          fetchMock().mockReset();
          fetchMock()
            .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [] }))
            .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, codiceAutorizzazione: 'X1', dettagliCarta: { expiry: '203112' } }));
          return new NexiProvider(config).chargeMandate(mandate(), charge);
        };
        const immediate = await run({ ...baseConfig, captureMode: 'immediate' });
        expect(immediate).toStrictEqual({
          status: 'succeeded',
          verified: true,
          chargeRef: CHARGE_REF,
          providerPaymentId: CHARGE_REF,
          raw: { codiceAutorizzazione: 'X1', cardExpiry: '203112' },
        });
        expect(immediate).toStrictEqual(await run(baseConfig));
      });

      it.each<[string, () => Response[]]>([
        ['an unsigned KO 19 (refusal)', () => [jsonResponse({ esito: 'KO', errore: { codice: 19, messaggio: 'Auth. Denied' } })]],
        ['a signed KO 14 (card expired)', () => [jsonResponse(signedKo(14))]],
        ['a KO 3 (merchant-side)', () => [jsonResponse({ esito: 'KO', errore: { codice: 3, messaggio: 'MAC errato' } })]],
        ['a KO 9 re-read as paid', () => [jsonResponse({ esito: 'KO', errore: { codice: 9 } }), jsonResponse({ ...OK_RESP, report: [PAID_ENTRY] })]],
        ['an HTTP 503', () => [jsonResponse({}, 503)]],
      ])("with 'immediate', %s gives the same result as without the option", async (_label, answers) => {
        const run = async (config: NexiProviderConfig) => {
          fetchMock().mockReset();
          fetchMock().mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [] }));
          for (const answer of answers()) fetchMock().mockResolvedValueOnce(answer);
          return new NexiProvider(config).chargeMandate(mandate(), charge);
        };
        const without = await run(baseConfig);
        const immediate = await run({ ...baseConfig, captureMode: 'immediate' });
        expect(immediate).toStrictEqual(without);
      });

      it("with 'immediate', a replay of an already paid chargeRef reads situazioneOrdine only and is unchanged", async () => {
        fetchMock().mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [PAID_ENTRY] }));
        const result = await new NexiProvider({ ...baseConfig, captureMode: 'immediate' }).chargeMandate(mandate(), charge);
        expect(fetchMock()).toHaveBeenCalledTimes(1);
        expect('parametriAggiuntivi' in callBody(0)).toBe(false);
        expect(result).toMatchObject({ status: 'succeeded', verified: true, providerStatus: 'Autorizzato' });
      });
    });

    describe('nothing else changes', () => {
      it("with 'immediate', getCharge, refundPayment, getMandate and revokeMandate send the default's requests", async () => {
        const requests = async (config: NexiProviderConfig) => {
          fetchMock().mockReset();
          fetchMock()
            .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [PAID_ENTRY] }))
            .mockResolvedValueOnce(jsonResponse(OK_RESP))
            .mockResolvedValueOnce(jsonResponse({ ...OK_RESP, contratti: [{ numeroContratto: MANDATE_REF, statoPrimoPag: 'OK' }] }))
            .mockResolvedValueOnce(jsonResponse(OK_RESP));
          const provider = new NexiProvider(config);
          await provider.getCharge(CHARGE_REF);
          await provider.refundPayment(CHARGE_REF, 19.9);
          await provider.getMandate(mandate());
          await provider.revokeMandate(mandate());
          return fetchMock().mock.calls.map(([url, init]) => ({ url: String(url), body: String((init as RequestInit).body) }));
        };
        const without = await requests(baseConfig);
        const immediate = await requests({ ...baseConfig, captureMode: 'immediate' });
        expect(immediate).toStrictEqual(without);
        for (const { body } of immediate) {
          expect(body).not.toContain('TCONTAB');
          expect(body).not.toContain('parametriAggiuntivi');
        }
      });
    });

    describe('config', () => {
      it.each(INVALID_CAPTURE_MODES.map((value) => [value]))('captureMode %j throws a TypeError in the constructor', (value) => {
        expect(() => new NexiProvider({ ...baseConfig, captureMode: value as never })).toThrow(TypeError);
        expect(() => new NexiProvider({ ...baseConfig, captureMode: value as never })).toThrow(
          "Invalid NexiProviderConfig.captureMode: expected 'profile' or 'immediate'",
        );
      });

      it("undefined, 'profile' and 'immediate' are accepted", () => {
        expect(() => new NexiProvider({ ...baseConfig, captureMode: undefined })).not.toThrow();
        expect(() => new NexiProvider({ ...baseConfig, captureMode: 'profile' })).not.toThrow();
        expect(() => new NexiProvider({ ...baseConfig, captureMode: 'immediate' })).not.toThrow();
      });
    });
  });
});
