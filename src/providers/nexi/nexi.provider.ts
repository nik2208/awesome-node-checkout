import * as crypto from 'crypto';
import { BasePaymentProvider } from '../../abstract/base-payment-provider.abstract';
import { generateOrderId } from '../../utils/ids';
import { currencyExponent, isInvalidAmountError, toMinorUnits } from '../../utils/money';
import { PaymentRequest } from '../../models/payment-request.model';
import { PaymentResult, WebhookResult } from '../../models/payment-result.model';
import { parseAmountFromCents, parseNexiCurrency } from '../../utils/parsing.util';
import { appendMandateRef } from '../../utils/url';
import { IMandateProvider } from '../../interfaces/mandate-provider.interface';
import {
  CHARGE_REF_PATTERN,
  ChargeRequest,
  ChargeResult,
  MANDATE_REF_PATTERN,
  Mandate,
  MandateCallbackInput,
  MandatePendingState,
  MandateRevokeResult,
  MandateSetupOutcome,
  MandateSetupRequest,
  MandateSetupStart,
  MandateStatusResult,
} from '../../models/mandate.model';

export interface NexiProviderConfig {
  merchantId: string;
  macKey: string;
  /** Optional group identifier */
  group?: string;
  /** @default 'sandbox' */
  environment?: 'sandbox' | 'production';
  /**
   * Timeout of the recurring-payment and contract API calls (`pagamentoRicorrente`,
   * `situazioneOrdine` replay guard, `dettagliContratto`, `cancellaContratto`), in ms.
   * @default 30000
   */
  timeoutMs?: number;
  /**
   * Mandates: contract type sent as `tipo_contratto` at setup (`S` scheduled, `U` unscheduled) and
   * included in the setup MAC. Only needed when the terminal is enabled for both kinds.
   */
  contractType?: 'S' | 'U';
}

/** Nexi XPay paid statuses (`situazioneOrdine` report `stato`, lower-case). */
const NEXI_PAID_STATUSES = new Set(['autorizzato', 'contabilizzato', 'catturato']);

/** Nexi XPay numeric code of EUR, the only currency `pagamentoRicorrente` accepts. */
const NEXI_EUR_NUMERIC = '978';

const EUR_ONLY = 'Nexi mandates support EUR only';

/** `pagamentoRicorrente` `importo`: cents, at most 8 digits (pp. 188-193). */
const NEXI_RECURRING_MAX_IMPORTO_DIGITS = 8;

/** Hosted-page `esito` values that are a final refusal of the setup. */
const NEXI_SETUP_REFUSALS = new Set(['KO', 'ANNULLO', 'ERRORE']);

/** Class of a "Tabella Codici errore API Restful" code (Nexi XPay manual v20.4, pp. 883-885). */
type NexiApiErrorClass = 'merchant' | 'duplicate' | 'notFound' | 'mandateUnusable' | 'declined';

/** Configuration, credentials or technical errors: never the customer's fault. */
const NEXI_MERCHANT_ERRORS = new Set([1, 3, 4, 5, 7, 12, 50, 97, 98, 99, 100]);
const NEXI_NOT_FOUND_ERRORS = new Set([2, 13]);
const NEXI_MANDATE_UNUSABLE_ERRORS = new Set([8, 14, 22]);
const NEXI_DUPLICATE_ERROR = 9;

/** The 7 fields covered by the hosted-page outcome MAC, plus the MAC itself. */
interface NexiOutcomeFields {
  codTrans: string;
  esito: string;
  importo: string;
  divisa: string;
  dataStr: string;
  orario: string;
  codAut: string;
  mac: unknown;
}

type LookupResult = {
  kind: 'paid' | 'other' | 'absent' | 'error';
  stato?: string;
  amount?: number;
  currency?: string;
};

/** A parsed JSON response of the XPay REST API, or why there is none. */
type ApiCallResult =
  | { ok: true; json: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Nexi eCommerce provider.
 * Flow: `redirect` — builds a signed checkout URL, redirects the user to Nexi,
 * then handles the POST-back via `handleRedirect`.
 *
 * Recurring payments (`IMandateProvider`): the setup is a hosted-page first payment that
 * registers a contract (`num_contratto` = `mandateRef`, `tipo_servizio=paga_multi`,
 * `tipo_richiesta=PP`); later charges use `pagamentoRicorrente`; `cancellaContratto` revokes.
 * EUR only. See "Specifiche tecniche di integrazione con il gateway di pagamento XPay" v20.4.
 *
 * Note: Nexi XPay mandates SHA-1 for MAC computation. This is a requirement of
 * the Nexi API and cannot be changed on the client side.
 */
export class NexiProvider extends BasePaymentProvider implements IMandateProvider {
  readonly name = 'nexi';
  readonly flow = 'redirect' as const;

  private readonly apiUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: NexiProviderConfig) {
    super();
    this.apiUrl =
      config.environment === 'production'
        ? 'https://ecommerce.nexi.it'
        : 'https://int-ecommerce.nexi.it';
    this.timeoutMs =
      typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
        ? config.timeoutMs
        : 30000;
  }

  /**
   * Computes the SHA-1 MAC required by Nexi to authenticate the payment request.
   * Format: `codTrans={val}divisa={val}importo={val}{macKey}`
   *
   * SHA-1 is used here because Nexi XPay mandates it for MAC computation.
   */
  private sha1(raw: string): string {
    return crypto.createHash('sha1').update(raw).digest('hex');
  }

  /**
   * Computes the SHA-1 MAC required by Nexi to authenticate the payment request.
   * Format: `codTrans={val}divisa={val}importo={val}{macKey}`
   *
   * SHA-1 is used here because Nexi XPay mandates it for MAC computation.
   */
  private generateMac(codTrans: string, divisa: string, importoCents: number): string {
    return this.sha1(`codTrans=${codTrans}divisa=${divisa}importo=${importoCents}${this.config.macKey}`);
  }

  /**
   * Computes the SHA-1 MAC for the status (bo/situazioneOrdine) API call.
   * Format: `apiKey={alias}codiceTransazione={codiceTransazione}timeStamp={timeStamp}{macKey}`
   */
  private generateStatusMac(alias: string, codiceTransazione: string, timeStamp: string): string {
    return this.sha1(`apiKey=${alias}codiceTransazione=${codiceTransazione}timeStamp=${timeStamp}${this.config.macKey}`);
  }

  /**
   * Computes the SHA-1 MAC for the refund (storno) API call.
   * Format: `alias={alias}codTrans={codTrans}importo={importo}timestamp={timestamp}{macKey}`
   */
  private generateRefundMac(
    alias: string,
    codTrans: string,
    importo: string,
    timestamp: string,
  ): string {
    return this.sha1(`alias=${alias}codTrans=${codTrans}importo=${importo}timestamp=${timestamp}${this.config.macKey}`);
  }

  /**
  /**
   * Validates that the MAC is a string of exactly 40 hexadecimal characters.
   */
  private isValidHexMac(mac: unknown): mac is string {
    return typeof mac === 'string' && /^[0-9a-fA-F]{40}$/.test(mac);
  }

  /**
   * Verifies the SHA-1 outcome MAC included in a Nexi POST-back response or server notification.
   * Format: `codTrans={codTrans}esito={esito}importo={importo}divisa={divisa}data={data}orario={orario}codAut={codAut}{macKey}`
   */
  private verifyResponseMac(
    codTrans: string,
    esito: string,
    importo: string,
    divisa: string,
    dataStr: string,
    orario: string,
    codAut: string,
    mac: string,
  ): boolean {
    if (!this.isValidHexMac(mac)) {
      return false;
    }
    const raw = `codTrans=${codTrans}esito=${esito}importo=${importo}divisa=${divisa}` +
      `data=${dataStr}orario=${orario}codAut=${codAut}${this.config.macKey}`;
    const expected = this.sha1(raw);
    const expBuf = Buffer.from(expected, 'hex');
    const macBuf = Buffer.from(mac, 'hex');
    if (expBuf.length !== macBuf.length || expBuf.length === 0) {
      return false;
    }
    return crypto.timingSafeEqual(expBuf, macBuf);
  }

  private safeVerifyResponseMac(
    codTrans: string,
    esito: string,
    importo: string,
    divisa: string,
    dataStr: string,
    orario: string,
    codAut: string,
    mac: string,
  ): boolean {
    try {
      return this.verifyResponseMac(codTrans, esito, importo, divisa, dataStr, orario, codAut, mac);
    } catch {
      return false;
    }
  }

  /**
   * Extracts the fields of a hosted-page outcome (redirect query or `urlpost` form). Missing
   * fields are `''`; `codTrans` falls back to `fallbackCodTrans` when given. `mac` is returned as
   * is, to be checked with `isValidHexMac`.
   */
  private extractOutcomeFields(
    data: Record<string, unknown> | undefined,
    fallbackCodTrans?: string,
  ): NexiOutcomeFields {
    const f = (k: string): string => {
      const v = data?.[k];
      return v === undefined || v === null ? '' : String(v);
    };
    const rawCodTrans = data?.['codTrans'];
    return {
      codTrans:
        rawCodTrans === undefined || rawCodTrans === null ? (fallbackCodTrans ?? '') : String(rawCodTrans),
      esito: f('esito'),
      importo: f('importo'),
      divisa: f('divisa'),
      dataStr: f('data'),
      orario: f('orario'),
      codAut: f('codAut'),
      mac: data?.['mac'],
    };
  }

  /** True when the 7-field outcome MAC of `fields` is present and valid (constant time). */
  private outcomeMacValid(fields: NexiOutcomeFields): boolean {
    const { codTrans, esito, importo, divisa, dataStr, orario, codAut, mac } = fields;
    return (
      this.isValidHexMac(mac) &&
      this.safeVerifyResponseMac(codTrans, esito, importo, divisa, dataStr, orario, codAut, mac)
    );
  }

  // ---------------------------------------------------------------------------
  // Recurring payments (mandates): MACs and API helpers
  // ---------------------------------------------------------------------------

  /** Constant-time comparison of a hex MAC against the expected SHA-1 hex digest. */
  private hexMacEquals(expected: string, mac: unknown): boolean {
    if (!this.isValidHexMac(mac)) return false;
    try {
      const expBuf = Buffer.from(expected, 'hex');
      const macBuf = Buffer.from(mac, 'hex');
      return expBuf.length === macBuf.length && expBuf.length > 0 && crypto.timingSafeEqual(expBuf, macBuf);
    } catch {
      return false;
    }
  }

  /**
   * Verifies the standard XPay REST response MAC:
   * `esito={esito}idOperazione={idOperazione}timeStamp={timeStamp}{macKey}`.
   */
  private responseMacValid(json: Record<string, unknown>): boolean {
    const str = (k: string): string => {
      const v = json[k];
      return v === undefined || v === null ? '' : String(v);
    };
    const expected = this.sha1(
      `esito=${str('esito')}idOperazione=${str('idOperazione')}timeStamp=${str('timeStamp')}${this.config.macKey}`,
    );
    return this.hexMacEquals(expected, json['mac']);
  }

  /**
   * MAC policy of the recurring and contract APIs: a present `mac` must be valid whatever the
   * `esito`; a missing one is tolerated only on `KO` (an error answer may carry none).
   */
  private responseAuthentic(json: Record<string, unknown>): boolean {
    const mac = json['mac'];
    if (mac === undefined || mac === null || mac === '') return json['esito'] === 'KO';
    return this.responseMacValid(json);
  }

  /**
   * Classifies a "Tabella Codici errore API Restful" code (pp. 883-885). A missing or
   * non-numeric code is `merchant`: without a code nothing says the customer is at fault.
   */
  private classifyApiError(codice: unknown): NexiApiErrorClass {
    const code =
      typeof codice === 'number' || (typeof codice === 'string' && /^\d+$/.test(codice.trim()))
        ? Number(codice)
        : NaN;
    if (!Number.isInteger(code)) return 'merchant';
    if (NEXI_MERCHANT_ERRORS.has(code)) return 'merchant';
    if (code === NEXI_DUPLICATE_ERROR) return 'duplicate';
    if (NEXI_NOT_FOUND_ERRORS.has(code)) return 'notFound';
    if (NEXI_MANDATE_UNUSABLE_ERRORS.has(code)) return 'mandateUnusable';
    return 'declined';
  }

  /** `errore.codice` / `errore.messaggio` of a response, when present. */
  private apiError(json: Record<string, unknown>): { codice: unknown; messaggio?: string } {
    const errore = json['errore'];
    if (errore === null || typeof errore !== 'object') return { codice: undefined };
    const e = errore as Record<string, unknown>;
    return {
      codice: e['codice'],
      messaggio: typeof e['messaggio'] === 'string' ? e['messaggio'] : undefined,
    };
  }

  /**
   * Computes the MAC of `pagamentoRicorrente` (p. 191). `scadenza` is not sent, so it is in the
   * string with an empty value, as the manual requires:
   * `apiKey=…numeroContratto=…codiceTransazione=…importo=…divisa=978scadenza=timeStamp=…{macKey}`.
   */
  private generateRecurringMac(
    numeroContratto: string,
    codiceTransazione: string,
    importo: string,
    timeStamp: string,
  ): string {
    return this.sha1(
      `apiKey=${this.config.merchantId}numeroContratto=${numeroContratto}` +
        `codiceTransazione=${codiceTransazione}importo=${importo}divisa=${NEXI_EUR_NUMERIC}` +
        `scadenza=timeStamp=${timeStamp}${this.config.macKey}`,
    );
  }

  /**
   * POSTs a JSON body to an XPay REST endpoint with the configured timeout. Never throws; the
   * error never contains the response body.
   */
  private async postApi(path: string, body: Record<string, string>): Promise<ApiCallResult> {
    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      return {
        ok: false,
        error: name === 'TimeoutError' || name === 'AbortError' ? 'Nexi API timeout' : 'Nexi API network error',
      };
    }
    if (!response || !response.ok) {
      return { ok: false, error: `Nexi API error: HTTP ${response?.status}` };
    }
    try {
      const json = (await response.json()) as unknown;
      if (json === null || typeof json !== 'object' || Array.isArray(json)) {
        return { ok: false, error: 'Invalid provider response' };
      }
      return { ok: true, json: json as Record<string, unknown> };
    } catch {
      return { ok: false, error: 'Invalid provider response' };
    }
  }

  /**
   * Reads `situazioneOrdine` for `codTrans` (same request as `getPaymentDetails`) and classifies
   * the raw response: `paid` (some entry for `codTrans` is paid), `other` (exists, no entry paid), `absent` (OK with no matching report
   * entry, or KO "not found" 2/13), `error` (anything else: HTTP, network, timeout, non-JSON, bad
   * MAC, a missing MAC on OK, no `report` array, any other KO).
   */
  private async lookupTransaction(codTrans: string): Promise<LookupResult> {
    const timeStamp = String(Date.now());
    const mac = this.generateStatusMac(this.config.merchantId, codTrans, timeStamp);
    const res = await this.postApi('/ecomm/api/bo/situazioneOrdine', {
      apiKey: this.config.merchantId,
      codiceTransazione: codTrans,
      timeStamp,
      mac,
    });
    if (!res.ok) return { kind: 'error' };
    const json = res.json;
    if (!this.responseAuthentic(json)) return { kind: 'error' };

    if (json['esito'] === 'KO') {
      return this.classifyApiError(this.apiError(json).codice) === 'notFound'
        ? { kind: 'absent' }
        : { kind: 'error' };
    }
    if (json['esito'] !== 'OK' || !Array.isArray(json['report'])) return { kind: 'error' };

    const entries = (json['report'] as unknown[]).filter(
      (r): r is Record<string, unknown> =>
        r !== null && typeof r === 'object' && (r as Record<string, unknown>)['codiceTransazione'] === codTrans,
    );
    if (entries.length === 0) return { kind: 'absent' };

    // Nexi may list a code more than once (it accepts up to 2 retries of a code after a KO): one
    // paid entry means the customer was charged, whatever the order of the entries
    const statoOf = (e: Record<string, unknown>) => (typeof e['stato'] === 'string' ? e['stato'] : undefined);
    const isPaid = (e: Record<string, unknown>) => {
      const stato = statoOf(e);
      return stato !== undefined && NEXI_PAID_STATUSES.has(stato.toLowerCase());
    };
    const entry = entries.find(isPaid) ?? entries[0];
    const stato = statoOf(entry);
    const amount = parseAmountFromCents(entry['importo']);
    const currency = parseNexiCurrency(entry['divisa']);
    return {
      kind: isPaid(entry) ? 'paid' : 'other',
      stato,
      ...(amount !== undefined ? { amount } : {}),
      ...(currency !== undefined ? { currency } : {}),
    };
  }

  async createPayment(request: PaymentRequest): Promise<PaymentResult> {
    try {
      // Outcome amounts (redirect, webhook, details) and refunds are read and sent in hundredths:
      // only 2-decimal currencies keep create, read-back and refund on the same scale.
      // Numeric codes ('392') are normalised so they are checked like their alpha-3 code.
      const currencyCode = parseNexiCurrency(request.currency) ?? request.currency;
      if (currencyExponent(currencyCode) !== 2) {
        return {
          success: false,
          error: 'Payment currency is not supported by Nexi: only currencies with 2 decimal places are accepted',
          status: 'FAILED',
        };
      }
      const amountCents = toMinorUnits(request.amount, currencyCode);
      const orderId = request.orderId ?? generateOrderId();
      const mac = this.generateMac(orderId, request.currency, amountCents);

      const params: Record<string, string> = {
        alias: this.config.merchantId,
        importo: amountCents.toString(),
        divisa: request.currency,
        codTrans: orderId,
        url: request.returnUrl,
        url_back: request.cancelUrl,
        mac,
      };

      if (request.notifyUrl) {
        params.urlpost = request.notifyUrl;
      }

      if (this.config.group) {
        params.gruppo = this.config.group;
      }

      const approvalUrl = `${this.apiUrl}/ecomm/ecomm/DispatcherServlet?${new URLSearchParams(params)}`;

      return {
        success: true,
        paymentId: orderId,
        approvalUrl,
        status: 'CREATED',
      };
    } catch (error) {
      if (isInvalidAmountError(error)) {
        return { success: false, error: error.message, status: 'FAILED' };
      }
      return this.errorResult(error, 'Failed to create Nexi payment');
    }
  }

  /**
   * Validates the POST-back data from Nexi.
   * `data` is the query/body object sent by Nexi to the returnUrl.
   * The outcome MAC is mandatory and verified over all 7 fields before the result is considered authoritative.
   * The result (`paymentId`, `orderId`) is keyed on the MAC-covered `codTrans`. When a non-empty
   * `paymentId` argument is given and differs from the outcome's `codTrans`, the call fails
   * (`success: false`, `verified: false`): a genuine outcome for one order cannot confirm another.
   */
  async executePayment(paymentId: string, data?: Record<string, string>): Promise<PaymentResult> {
    try {
      const requestedId = typeof paymentId === 'string' && paymentId !== '' ? paymentId : undefined;
      const fields = this.extractOutcomeFields(data, requestedId);
      const { codTrans, esito, importo, divisa, mac } = fields;

      if (!mac) {
        return {
          success: false,
          verified: false,
          paymentId: undefined,
          status: 'FAILED',
          error: 'MAC missing',
        };
      }

      if (!this.outcomeMacValid(fields)) {
        return {
          success: false,
          verified: false,
          paymentId: undefined,
          status: 'FAILED',
          error: 'MAC verification failed: response may have been tampered with',
        };
      }

      if (requestedId !== undefined && requestedId !== codTrans) {
        return {
          success: false,
          verified: false,
          paymentId: undefined,
          status: 'FAILED',
          error: 'Payment id does not match the outcome',
        };
      }

      const amount = parseAmountFromCents(importo);
      const currency = parseNexiCurrency(divisa);
      const isPaid = esito === 'OK' && amount !== undefined && amount > 0 && !!currency && currency.trim() !== '';

      return {
        success: isPaid,
        verified: true,
        paymentId: codTrans,
        orderId: codTrans,
        status: esito === 'OK' ? 'COMPLETED' : 'FAILED',
        amount,
        currency,
        raw: data,
        ...(isPaid
          ? {}
          : {
              error:
                esito === 'OK'
                  ? (amount === undefined || amount <= 0
                      ? 'Payment amount is missing or invalid'
                      : 'Payment currency is missing or invalid')
                  : `Payment failed with outcome ${esito}`,
            }),
      };
    } catch (error) {
      return { ...this.errorResult(error, 'Failed to execute Nexi payment'), verified: false };
    }
  }

  /**
   * Handles the incoming server-to-server outcome notification (urlpost) from Nexi.
   * The outcome MAC is mandatory and verified over all 7 fields.
   */
  async handleWebhook(
    body?: Record<string, unknown>,
    _headers: Record<string, string> = {},
  ): Promise<WebhookResult> {
    try {
      if (!body) {
        return { success: false, verified: false, error: 'MAC verification failed' };
      }
      const f = (k: string) => String(body?.[k] ?? '');
      const codTrans = f('codTrans');
      const esito = f('esito');
      const importo = f('importo');
      const divisa = f('divisa');
      const dataStr = f('data');
      const orario = f('orario');
      const codAut = f('codAut');
      const mac = body?.['mac'];

      if (!this.isValidHexMac(mac) || !this.safeVerifyResponseMac(codTrans, esito, importo, divisa, dataStr, orario, codAut, mac)) {
        return {
          success: false,
          verified: false,
          paymentId: undefined,
          error: 'MAC verification failed',
        };
      }

      const amount = parseAmountFromCents(importo);
      const currency = parseNexiCurrency(divisa);
      const isPaid = esito === 'OK' && amount !== undefined && amount > 0 && !!currency && currency.trim() !== '';

      return {
        success: isPaid,
        verified: true,
        paymentId: codTrans,
        orderId: codTrans,
        status: esito === 'OK' ? 'COMPLETED' : 'FAILED',
        amount,
        currency,
        raw: body,
        ...(isPaid
          ? {}
          : {
              error:
                esito === 'OK'
                  ? (amount === undefined || amount <= 0
                      ? 'Payment amount is missing or invalid'
                      : 'Payment currency is missing or invalid')
                  : `Payment failed with outcome ${esito}`,
            }),
      };
    } catch (error) {
      return { success: false, verified: false, error: 'MAC verification failed' };
    }
  }

  async getPaymentDetails(paymentId: string): Promise<PaymentResult> {
    try {
      const timeStamp = String(Date.now());
      const mac = this.generateStatusMac(this.config.merchantId, paymentId, timeStamp);

      const requestBody = {
        apiKey: this.config.merchantId,
        codiceTransazione: paymentId,
        timeStamp,
        mac,
      };

      const response = await fetch(`${this.apiUrl}/ecomm/api/bo/situazioneOrdine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) throw new Error(`Nexi API error: HTTP ${response.status}`);
      let result: Record<string, unknown>;
      try {
        result = (await response.json()) as Record<string, unknown>;
      } catch {
        throw new Error('Invalid provider response');
      }

      const esito = String(result['esito'] ?? '');
      if (esito !== 'OK') {
        const errMsg = 'Payment details request failed';
        return { success: false, paymentId, error: errMsg, raw: result };
      }

      // Verify response MAC
      const idOperazione = String(result['idOperazione'] ?? '');
      const respTimeStamp = String(result['timeStamp'] ?? '');
      const expectedMac = this.sha1(`esito=${esito}idOperazione=${idOperazione}timeStamp=${respTimeStamp}${this.config.macKey}`);
      const respMac = result['mac'];

      if (!this.isValidHexMac(respMac)) {
        return {
          success: false,
          paymentId,
          error: 'MAC verification failed: response may have been tampered with',
          raw: result,
        };
      }

      const expBuf = Buffer.from(expectedMac, 'hex');
      const macBuf = Buffer.from(respMac, 'hex');
      let macValid = false;
      try {
        macValid = expBuf.length === macBuf.length && expBuf.length > 0 && crypto.timingSafeEqual(expBuf, macBuf);
      } catch {
        macValid = false;
      }

      if (!macValid) {
        return {
          success: false,
          paymentId,
          error: 'MAC verification failed: response may have been tampered with',
          raw: result,
        };
      }

      const report = Array.isArray(result['report']) ? result['report'] : [];
      const item = report.find((r: any) => r?.codiceTransazione === paymentId);
      if (!item) {
        return {
          success: false,
          paymentId,
          error: 'Report not found',
          raw: result,
        };
      }

      const stato = item.stato as string;
      const amount = parseAmountFromCents(item.importo);
      const currency = parseNexiCurrency(item.divisa);

      const statoStr = typeof stato === 'string' ? stato.toLowerCase() : '';
      const isPaidStatus = NEXI_PAID_STATUSES.has(statoStr);
      const isSuccess = isPaidStatus && amount !== undefined && amount > 0 && !!currency && currency.trim() !== '';

      return {
        success: isSuccess,
        verified: true,
        paymentId,
        status: stato,
        amount,
        currency,
        raw: result,
        ...(isSuccess
          ? {}
          : {
              error:
                isPaidStatus
                  ? (amount === undefined || amount <= 0
                      ? 'Payment amount is missing or invalid'
                      : 'Payment currency is missing or invalid')
                  : `Payment status is ${stato ?? 'unknown'}`,
            }),
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to get Nexi payment details');
    }
  }

  async refundPayment(paymentId: string, amount?: number): Promise<PaymentResult> {
    try {
      const timestamp = new Date().toISOString();
      // The refund API carries no currency. createPayment accepts only 2-decimal currencies,
      // so a partial amount is always in hundredths. Only an omitted (undefined) amount means a
      // full refund, as in PayPal: 0 and null are rejected by toMinorUnits like any invalid amount.
      const importo = amount !== undefined ? toMinorUnits(amount, 'EUR').toString() : '';
      const mac = this.generateRefundMac(this.config.merchantId, paymentId, importo, timestamp);

      const params: Record<string, string> = {
        alias: this.config.merchantId,
        codTrans: paymentId,
        importo,
        timestamp,
        mac,
      };

      const response = await fetch(`${this.apiUrl}/ecomm/api/vas/igfs/storno/plain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
      });

      if (!response.ok) throw new Error(`Nexi API error: HTTP ${response.status}`);
      let result: Record<string, unknown>;
      try {
        result = (await response.json()) as Record<string, unknown>;
      } catch {
        throw new Error('Invalid provider response');
      }

      return {
        success: result['esito'] === 'OK',
        paymentId,
        status: result['esito'] === 'OK' ? 'REFUNDED' : 'REFUND_FAILED',
        raw: result,
      };
    } catch (error) {
      if (isInvalidAmountError(error)) {
        return { success: false, error: error.message, status: 'FAILED' };
      }
      return this.errorResult(error, 'Failed to refund Nexi payment');
    }
  }

  /**
   * Handles the POST-back from Nexi to the returnUrl.
   * Nexi sends `esito`, `codTrans`, `importo`, `divisa`, `mac`, `data`, `orario`, `codAut` etc.
   * The outcome MAC is mandatory and verified over all 7 fields to ensure authenticity.
   */
  async handleRedirect(query: Record<string, string>): Promise<PaymentResult> {
    return this.executePayment(query['codTrans'] ?? '', query);
  }

  // ---------------------------------------------------------------------------
  // Recurring payments (mandates) — IMandateProvider
  // ---------------------------------------------------------------------------

  /**
   * Starts a contract registration: a hosted-page first payment with `num_contratto` =
   * `mandateRef`, `tipo_servizio=paga_multi`, `tipo_richiesta=PP` (pp. 59-65), charging the first
   * period. `codTrans` is `orderId`. EUR only. `mandate_ref` is appended to `url`, `url_back` and
   * `urlpost`.
   */
  async createMandate(request: MandateSetupRequest): Promise<MandateSetupStart> {
    try {
      if (request.currency !== 'EUR') {
        return { success: false, error: EUR_ONLY };
      }
      if (!MANDATE_REF_PATTERN.test(request.mandateRef) || !CHARGE_REF_PATTERN.test(request.orderId)) {
        return { success: false, error: 'Invalid mandateRef or orderId for Nexi' };
      }
      const importo = toMinorUnits(request.amount, 'EUR');
      const codTrans = request.orderId;
      const contractType = this.config.contractType;
      const mac =
        contractType === undefined
          ? this.generateMac(codTrans, 'EUR', importo)
          : this.sha1(
              `codTrans=${codTrans}divisa=EURimporto=${importo}tipo_contratto=${contractType}${this.config.macKey}`,
            );

      const params: Record<string, string> = {
        alias: this.config.merchantId,
        importo: String(importo),
        divisa: 'EUR',
        codTrans,
        url: appendMandateRef(request.returnUrl, request.mandateRef),
        url_back: appendMandateRef(request.cancelUrl, request.mandateRef),
        mac,
        num_contratto: request.mandateRef,
        tipo_servizio: 'paga_multi',
        tipo_richiesta: 'PP',
      };
      if (contractType !== undefined) params.tipo_contratto = contractType;
      if (request.notifyUrl) params.urlpost = appendMandateRef(request.notifyUrl, request.mandateRef);
      if (this.config.group) params.gruppo = this.config.group;

      return {
        success: true,
        approvalUrl: `${this.apiUrl}/ecomm/ecomm/DispatcherServlet?${new URLSearchParams(params)}`,
        pending: {
          provider: this.name,
          mandateRef: request.mandateRef,
          orderId: codTrans,
          amount: request.amount,
          currency: 'EUR',
          providerRef: codTrans,
          createdAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      if (isInvalidAmountError(error)) return { success: false, error: error.message };
      if (error instanceof TypeError) return { success: false, error: 'Invalid returnUrl, cancelUrl or notifyUrl' };
      return { success: false, error: 'Failed to create Nexi mandate' };
    }
  }

  /**
   * Confirms a setup from the hosted-page outcome: the redirect on `url` (GET query) or the
   * `urlpost` notification (form POST). Pure function of its inputs, hence idempotent.
   *
   * - The 7-field outcome MAC must be valid, and the MAC-covered `codTrans`, `importo` and
   *   `divisa` must match `pending`; otherwise the outcome is unverified and non-terminal (a forged
   *   callback never consumes the pending state). The unsigned `num_contratto`, when present, must
   *   be `pending.mandateRef` (and `tipo_servizio` / `tipo_richiesta`, when present, `paga_multi` /
   *   `PP`); the contract number used is always `pending.mandateRef`.
   * - `esito=OK` with `num_contratto`: active mandate, first charge `succeeded` (terminal). An OK
   *   without `num_contratto` is unverified and non-terminal (no contract may exist).
   * - `esito` `KO`, `ANNULLO` or `ERRORE`: no mandate, first charge `failed` (terminal). Start a
   *   new setup with a fresh `mandateRef` and `orderId`: a `codTrans` is never reused.
   * - Any other `esito` (e.g. a pending one) is unverified and non-terminal: it may still turn OK.
   *
   * An empty input (`{}`) has no MAC, so a re-confirm is unverified and non-terminal: Nexi never
   * reports a terminal outcome with an `unknown` first charge.
   */
  async confirmMandate(pending: MandatePendingState, input: MandateCallbackInput): Promise<MandateSetupOutcome> {
    const unverified = (error: string): MandateSetupOutcome => ({
      success: false,
      verified: false,
      terminal: false,
      firstCharge: { status: 'unknown', verified: false, chargeRef: pending.orderId, error },
      error,
    });
    try {
      const params: Record<string, string> = {};
      for (const source of [input?.query, input?.body]) {
        if (source === null || typeof source !== 'object') continue;
        for (const [k, v] of Object.entries(source)) {
          if (typeof v === 'string') params[k] = v;
        }
      }

      const fields = this.extractOutcomeFields(params);
      if (!this.outcomeMacValid(fields)) return unverified('Invalid outcome MAC');

      if (fields.codTrans !== pending.orderId) {
        return unverified('Outcome does not match the pending setup');
      }
      if (fields.importo !== String(toMinorUnits(pending.amount, 'EUR')) || fields.divisa !== 'EUR') {
        return unverified('Outcome amount does not match');
      }
      // Not MAC-covered: only tampering indicators, never the source of the contract number
      if (params['num_contratto'] !== undefined && params['num_contratto'] !== pending.mandateRef) {
        return unverified('Outcome does not match the pending setup');
      }
      if (
        (params['tipo_servizio'] !== undefined && params['tipo_servizio'] !== 'paga_multi') ||
        (params['tipo_richiesta'] !== undefined && params['tipo_richiesta'] !== 'PP')
      ) {
        return unverified('Outcome does not match the pending setup');
      }

      if (fields.esito === 'OK') {
        // Nexi echoes num_contratto on a contract-registering outcome. Without it, the customer may
        // have stripped the contract parameters from the (unsigned) approvalUrl, so a plain payment
        // was made and no contract may exist: never report that as an active mandate.
        if (params['num_contratto'] === undefined) {
          return unverified('Outcome does not match the pending setup');
        }
        const unverifiedHints: NonNullable<Mandate['unverified']> = {};
        const scadenzaPan = params['scadenza_pan'];
        if (scadenzaPan !== undefined && /^\d{6}$/.test(scadenzaPan)) unverifiedHints.cardExpiry = scadenzaPan;
        const pan = params['pan'];
        if (pan !== undefined && /^[0-9*]{8,19}$/.test(pan)) unverifiedHints.maskedPan = pan;

        const mandate: Mandate = {
          provider: this.name,
          mandateRef: pending.mandateRef,
          providerMandateId: pending.mandateRef,
          status: 'active',
          createdAt: new Date().toISOString(),
          ...(Object.keys(unverifiedHints).length > 0 ? { unverified: unverifiedHints } : {}),
        };
        return {
          success: true,
          verified: true,
          terminal: true,
          mandate,
          firstCharge: {
            status: 'succeeded',
            verified: true,
            chargeRef: pending.orderId,
            providerPaymentId: pending.orderId,
            amount: pending.amount,
            currency: 'EUR',
          },
          raw: params,
        };
      }

      if (!NEXI_SETUP_REFUSALS.has(fields.esito)) {
        // e.g. a pending outcome: the setup may still turn OK, so the pending state must survive
        return unverified(`Mandate setup outcome ${fields.esito} is not final`);
      }

      const messaggio = params['messaggio'];
      const codiceEsito = params['codiceEsito'];
      return {
        success: false,
        verified: true,
        terminal: true,
        firstCharge: {
          status: 'failed',
          verified: true,
          chargeRef: pending.orderId,
          error: messaggio !== undefined && messaggio !== '' ? messaggio : fields.esito,
          ...(codiceEsito !== undefined ? { providerCode: codiceEsito } : {}),
        },
        error: `Mandate setup failed with outcome ${fields.esito}`,
        raw: params,
      };
    } catch {
      return unverified('Mandate outcome could not be verified');
    }
  }

  /**
   * Merchant-initiated charge with `pagamentoRicorrente` (pp. 188-193), EUR only.
   * `codiceTransazione` is `charge.chargeRef`, so `refundPayment(chargeRef, amount)` refunds it.
   *
   * Replay guard: `situazioneOrdine` is read first. A paid transaction is returned as
   * `succeeded` without charging again; an existing unpaid one is `failed` (a dunning retry needs
   * a new `chargeRef`: Nexi's own retries of a code after a KO are not used); a lookup error is
   * `unknown` and nothing is charged. A Nexi "transaction already present" (9) is re-read.
   * Merchant-side errors (credentials, MAC, technical) are `unknown`, never `failed`.
   */
  async chargeMandate(mandate: Mandate, charge: ChargeRequest): Promise<ChargeResult> {
    const chargeRef = charge.chargeRef;
    const unknown = (error: string, providerCode?: string): ChargeResult => ({
      status: 'unknown',
      verified: false,
      chargeRef,
      error,
      ...(providerCode !== undefined ? { providerCode } : {}),
    });
    const fromLookup = (lookup: LookupResult): ChargeResult => ({
      status: 'succeeded',
      verified: true,
      chargeRef,
      providerPaymentId: chargeRef,
      ...(lookup.amount !== undefined ? { amount: lookup.amount } : {}),
      ...(lookup.currency !== undefined ? { currency: lookup.currency } : {}),
    });

    try {
      if (charge.currency !== 'EUR') {
        return { status: 'failed', verified: false, chargeRef, error: EUR_ONLY };
      }
      if (typeof chargeRef !== 'string' || chargeRef.includes('_')) {
        return { status: 'failed', verified: false, chargeRef, error: 'Nexi codiceTransazione cannot contain "_"' };
      }
      const importo = String(toMinorUnits(charge.amount, 'EUR'));
      if (importo.length > NEXI_RECURRING_MAX_IMPORTO_DIGITS) {
        // pagamentoRicorrente takes at most 8 digits of cents (pp. 188-193): Nexi would answer KO 1
        // (a merchant-side `unknown`), and a retry with the same chargeRef could never succeed
        return {
          status: 'failed',
          verified: false,
          chargeRef,
          error: 'Amount exceeds the Nexi recurring limit (8 digits of cents)',
        };
      }

      // Replay guard: never charge twice for the same chargeRef
      const lookup = await this.lookupTransaction(chargeRef);
      if (lookup.kind === 'paid') return fromLookup(lookup);
      if (lookup.kind === 'other') {
        return {
          status: 'failed',
          verified: true,
          chargeRef,
          error: `A transaction with this chargeRef already exists: ${lookup.stato ?? 'unknown'}`,
        };
      }
      if (lookup.kind !== 'absent') {
        return unknown('Could not check whether this chargeRef was already charged');
      }

      const numeroContratto = mandate.providerMandateId;
      const timeStamp = String(Date.now());
      const body: Record<string, string> = {
        apiKey: this.config.merchantId,
        numeroContratto,
        codiceTransazione: chargeRef,
        importo,
        divisa: NEXI_EUR_NUMERIC,
        timeStamp,
        mac: this.generateRecurringMac(numeroContratto, chargeRef, importo, timeStamp),
      };
      if (this.config.group) body.codiceGruppo = this.config.group;

      const res = await this.postApi('/ecomm/api/recurring/pagamentoRicorrente', body);
      if (!res.ok) return unknown(res.error);
      const json = res.json;
      if (!this.responseAuthentic(json)) return unknown('Response MAC mismatch');

      if (json['esito'] === 'OK') {
        const raw: Record<string, unknown> = {};
        if (json['codiceAutorizzazione'] !== undefined) raw.codiceAutorizzazione = json['codiceAutorizzazione'];
        const dettagli = json['dettagliCarta'];
        const expiry =
          dettagli !== null && typeof dettagli === 'object'
            ? (dettagli as Record<string, unknown>)['expiry']
            : undefined;
        if (typeof expiry === 'string' && /^\d{6}$/.test(expiry)) raw.cardExpiry = expiry;
        // The response carries no amount: amount and currency are deliberately not set
        return { status: 'succeeded', verified: true, chargeRef, providerPaymentId: chargeRef, raw };
      }
      if (json['esito'] !== 'KO') return unknown('Unexpected Nexi outcome');

      const { codice, messaggio } = this.apiError(json);
      const providerCode = codice === undefined || codice === null ? undefined : String(codice);
      const raw = { esito: 'KO', ...(providerCode !== undefined ? { codice: providerCode } : {}) };
      switch (this.classifyApiError(codice)) {
        case 'duplicate': {
          const again = await this.lookupTransaction(chargeRef);
          if (again.kind === 'paid') return fromLookup(again);
          return unknown('Transaction already present', providerCode);
        }
        case 'merchant':
          return { ...unknown('Nexi refused the request (merchant-side error)', providerCode), raw };
        case 'mandateUnusable':
          return {
            status: 'failed',
            verified: true,
            chargeRef,
            mandateUnusable: true,
            error: messaggio ?? 'Mandate is no longer usable',
            ...(providerCode !== undefined ? { providerCode } : {}),
            raw,
          };
        default:
          return {
            status: 'failed',
            verified: true,
            chargeRef,
            error: messaggio ?? 'Payment refused',
            ...(providerCode !== undefined ? { providerCode } : {}),
            raw,
          };
      }
    } catch (error) {
      if (isInvalidAmountError(error)) {
        return { status: 'failed', verified: false, chargeRef, error: error.message };
      }
      return unknown('Charge outcome unknown');
    }
  }

  /**
   * Re-reads the contract with `dettagliContratto` (pp. 851-853). `active` when it is listed and
   * its first payment is not KO; `revoked` when its first payment is KO or Nexi answers "not
   * found" or "invalid contract"; otherwise `unknown` (unverified).
   */
  async getMandate(mandate: Mandate): Promise<MandateStatusResult> {
    try {
      const numeroContratto = mandate.providerMandateId;
      const timeStamp = String(Date.now());
      const mac = this.sha1(
        `apiKey=${this.config.merchantId}numeroContratto=${numeroContratto}codiceFiscale=` +
          `dataRegistrazioneDa=dataRegistrazioneA=timeStamp=${timeStamp}${this.config.macKey}`,
      );
      const res = await this.postApi('/ecomm/api/contratti/dettagliContratto', {
        apiKey: this.config.merchantId,
        numeroContratto,
        codiceFiscale: '',
        dataRegistrazioneDa: '',
        dataRegistrazioneA: '',
        timeStamp,
        mac,
      });
      if (!res.ok) return { status: 'unknown', verified: false };
      const json = res.json;
      if (!this.responseAuthentic(json)) return { status: 'unknown', verified: false, raw: json };

      if (json['esito'] === 'OK' && Array.isArray(json['contratti'])) {
        const entry = (json['contratti'] as unknown[]).find(
          (c): c is Record<string, unknown> =>
            c !== null && typeof c === 'object' && (c as Record<string, unknown>)['numeroContratto'] === numeroContratto,
        );
        if (entry) {
          const stato = entry['statoPrimoPag'];
          const ko = typeof stato === 'string' && stato.toUpperCase() === 'KO';
          return { status: ko ? 'revoked' : 'active', verified: true, raw: json };
        }
      }
      if (json['esito'] === 'KO') {
        const kind = this.classifyApiError(this.apiError(json).codice);
        if (kind === 'notFound' || kind === 'mandateUnusable') {
          return { status: 'revoked', verified: true, raw: json };
        }
      }
      return { status: 'unknown', verified: false, raw: json };
    } catch {
      return { status: 'unknown', verified: false };
    }
  }

  /**
   * Cancels the contract with `cancellaContratto` (pp. 838-840). "Not found" and "invalid
   * contract" count as revoked: the contract is already gone.
   */
  async revokeMandate(mandate: Mandate): Promise<MandateRevokeResult> {
    try {
      const numeroContratto = mandate.providerMandateId;
      const timeStamp = String(Date.now());
      const mac = this.sha1(
        `apiKey=${this.config.merchantId}numeroContratto=${numeroContratto}timeStamp=${timeStamp}${this.config.macKey}`,
      );
      const res = await this.postApi('/ecomm/api/contratti/cancellaContratto', {
        apiKey: this.config.merchantId,
        numeroContratto,
        timeStamp,
        mac,
      });
      if (!res.ok) return { revokedAtProvider: false, error: res.error };
      const json = res.json;
      if (!this.responseAuthentic(json)) {
        return { revokedAtProvider: false, error: 'Response MAC mismatch', raw: json };
      }
      if (json['esito'] === 'OK') return { revokedAtProvider: true, raw: json };
      if (json['esito'] === 'KO') {
        const { codice } = this.apiError(json);
        const kind = this.classifyApiError(codice);
        if (kind === 'notFound' || kind === 'mandateUnusable') return { revokedAtProvider: true, raw: json };
        return {
          revokedAtProvider: false,
          error: `Nexi refused the cancellation (code ${codice === undefined ? 'missing' : String(codice)})`,
          raw: json,
        };
      }
      return { revokedAtProvider: false, error: 'Unexpected Nexi outcome', raw: json };
    } catch {
      return { revokedAtProvider: false, error: 'Failed to revoke Nexi mandate' };
    }
  }
}
