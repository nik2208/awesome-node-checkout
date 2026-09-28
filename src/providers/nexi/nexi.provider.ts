import * as crypto from 'crypto';
import { BasePaymentProvider } from '../../abstract/base-payment-provider.abstract';
import { PaymentRequest } from '../../models/payment-request.model';
import { PaymentResult, WebhookResult } from '../../models/payment-result.model';
import { parseAmountFromCents, parseNexiCurrency } from '../../utils/parsing.util';

export interface NexiProviderConfig {
  merchantId: string;
  macKey: string;
  /** Optional group identifier */
  group?: string;
  /** @default 'sandbox' */
  environment?: 'sandbox' | 'production';
}

/**
 * Nexi eCommerce provider.
 * Flow: `redirect` — builds a signed checkout URL, redirects the user to Nexi,
 * then handles the POST-back via `handleRedirect`.
 *
 * Note: Nexi XPay mandates SHA-1 for MAC computation. This is a requirement of
 * the Nexi API and cannot be changed on the client side.
 */
export class NexiProvider extends BasePaymentProvider {
  readonly name = 'nexi';
  readonly flow = 'redirect' as const;

  private readonly apiUrl: string;

  constructor(private readonly config: NexiProviderConfig) {
    super();
    this.apiUrl =
      config.environment === 'production'
        ? 'https://ecommerce.nexi.it'
        : 'https://int-ecommerce.nexi.it';
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

  async createPayment(request: PaymentRequest): Promise<PaymentResult> {
    try {
      const amountCents = Math.round(request.amount * 100);
      const orderId = request.orderId ?? `ORD-${Date.now()}`;
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
      return this.errorResult(error, 'Failed to create Nexi payment');
    }
  }

  /**
   * Validates the POST-back data from Nexi.
   * `data` is the query/body object sent by Nexi to the returnUrl.
   * The outcome MAC is mandatory and verified over all 7 fields before the result is considered authoritative.
   */
  async executePayment(paymentId: string, data?: Record<string, string>): Promise<PaymentResult> {
    try {
      const esito: string = data?.esito ?? '';
      const codTrans: string = data?.codTrans ?? paymentId;
      const importo: string = data?.importo ?? '';
      const divisa: string = data?.divisa ?? '';
      const dataStr: string = (data as any)?.data ?? '';
      const orario: string = (data as any)?.orario ?? '';
      const codAut: string = (data as any)?.codAut ?? '';
      const mac = data?.mac;

      if (!mac) {
        return {
          success: false,
          paymentId: codTrans,
          status: 'FAILED',
          error: 'MAC missing',
        };
      }

      if (!this.isValidHexMac(mac) || !this.safeVerifyResponseMac(codTrans, esito, importo, divisa, dataStr, orario, codAut, mac)) {
        return {
          success: false,
          paymentId: codTrans,
          status: 'FAILED',
          error: 'MAC verification failed: response may have been tampered with',
        };
      }

      const amount = parseAmountFromCents(importo);
      const currency = parseNexiCurrency(divisa);

      return {
        success: esito === 'OK',
        paymentId: codTrans,
        status: esito === 'OK' ? 'COMPLETED' : 'FAILED',
        amount,
        currency,
        raw: data,
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to execute Nexi payment');
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
        return { success: false, error: 'MAC verification failed' };
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
          paymentId: codTrans || undefined,
          error: 'MAC verification failed',
        };
      }

      const amount = parseAmountFromCents(importo);
      const currency = parseNexiCurrency(divisa);

      return {
        success: esito === 'OK',
        paymentId: codTrans,
        status: esito === 'OK' ? 'COMPLETED' : 'FAILED',
        amount,
        currency,
        raw: body,
      };
    } catch (error) {
      return { success: false, error: 'MAC verification failed' };
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

      if (!response.ok) throw new Error(`Nexi API error: ${response.statusText}`);
      const result = await response.json() as Record<string, unknown>;

      const esito = String(result['esito'] ?? '');
      if (esito !== 'OK') {
        const errMsg = (result['errore'] as any)?.messaggio ?? 'Payment details request failed';
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

      return {
        success: true,
        paymentId,
        status: stato,
        amount,
        currency,
        raw: result,
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to get Nexi payment details');
    }
  }

  async refundPayment(paymentId: string, amount?: number): Promise<PaymentResult> {
    try {
      const timestamp = new Date().toISOString();
      const importo = amount ? Math.round(amount * 100).toString() : '';
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

      if (!response.ok) throw new Error(`Nexi API error: ${response.statusText}`);
      const result = await response.json() as Record<string, unknown>;

      return {
        success: result['esito'] === 'OK',
        paymentId,
        status: result['esito'] === 'OK' ? 'REFUNDED' : 'REFUND_FAILED',
        raw: result,
      };
    } catch (error) {
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
}
